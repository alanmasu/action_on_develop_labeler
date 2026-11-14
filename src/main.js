'use strict';

const { parseClosingRefs, revertedSha, revertedPr } = require('./parse');
const { openProject, tokenHint } = require('./project');

const MAX_REVERT_DEPTH = 5;
const MAX_COMPARE_PAGES = 30;

/**
 * Entry point, chiamato da actions/github-script.
 * @param {{github: any, context: any, core: any, getOctokit?: Function, env?: NodeJS.ProcessEnv}} deps
 */
module.exports = async function run({ github, context, core, getOctokit, env = process.env }) {
  const opts = {
    label: (env.OD_LABEL || 'on develop').trim(),
    color: (env.OD_LABEL_COLOR || '8521fc').replace(/^#/, ''),
    description: env.OD_LABEL_DESCRIPTION || 'Fix merged into develop, waiting for release',
    skipLabel: (env.OD_SKIP_LABEL || '').trim(),
    dryRun: /^(1|true|yes)$/i.test(env.OD_DRY_RUN || ''),
    project: (env.OD_PROJECT_URL || '').trim(),
    projectToken: env.OD_PROJECT_TOKEN || '',
    statusField: (env.OD_STATUS_FIELD || 'Status').trim(),
    statusOnDevelop: (env.OD_STATUS_ON_DEVELOP || '').trim(),
    statusOnRevert: (env.OD_STATUS_ON_REVERT || '').trim(),
  };
  const current = { owner: context.repo.owner, repo: context.repo.repo };
  // output sempre presenti, anche quando si esce subito (step successivi li confrontano con '[]')
  core.setOutput('labeled', '[]');
  core.setOutput('unlabeled', '[]');
  core.setOutput('skipped', '[]');

  // project: validato subito, così un nome sbagliato ferma tutto prima di toccare le issue
  let project = null;
  if (opts.project) {
    if (!opts.statusOnDevelop && !opts.statusOnRevert) {
      throw new Error('Con "project-url" serve almeno uno tra "status-on-develop" e "status-on-revert".');
    }
    const projectGh = opts.projectToken && getOctokit ? getOctokit(opts.projectToken) : github;
    project = await openProject(projectGh, {
      url: opts.project,
      fieldName: opts.statusField,
      options: [opts.statusOnDevelop, opts.statusOnRevert],
    });
    core.info(`Project "${project.title}": ${opts.statusField} -> "${opts.statusOnDevelop || '-'}" / revert -> "${opts.statusOnRevert || '-'}"`);
  } else if (opts.statusOnDevelop || opts.statusOnRevert) {
    throw new Error('"status-on-develop" / "status-on-revert" richiedono "project-url".');
  }
  const defaultBranch = context.payload.repository && context.payload.repository.default_branch;

  /** key -> { ref, action: 'add' | 'remove', source } ; l'ultimo evento vince */
  const effects = new Map();
  const record = (list, source) => {
    for (const e of list) effects.set(e.ref.key, { ...e, source });
  };

  // ---------------------------------------------------------------- helpers
  const invert = (list) => list.map((e) => ({ ...e, action: e.action === 'add' ? 'remove' : 'add' }));

  /** Effetto di un messaggio di commit: Fixes -> add, revert -> inverso del commit annullato. */
  async function effectsOfMessage(message, depth) {
    const sha = revertedSha(message);
    if (sha) {
      if (depth >= MAX_REVERT_DEPTH) return [];
      return invert(await effectsOfSha(sha, depth + 1));
    }
    return parseClosingRefs(message, current).map((ref) => ({ ref, action: 'add' }));
  }

  /** Come effectsOfMessage ma partendo da uno SHA; i merge commit includono la PR intera. */
  async function effectsOfSha(sha, depth) {
    let data;
    try {
      ({ data } = await github.rest.repos.getCommit({ ...current, ref: sha }));
    } catch (e) {
      core.warning(`Commit ${sha.slice(0, 7)} annullato da un revert non trovato: ${e.message}`);
      return [];
    }
    const out = await effectsOfMessage(data.commit.message, depth);
    if ((data.parents || []).length > 1 && !revertedSha(data.commit.message)) {
      // revert di un merge commit: annulla tutto ciò che la PR aveva portato
      const pr = await prMergedBy(data.sha);
      if (pr) out.push(...(await effectsOfPr(pr, depth)));
    }
    return out;
  }

  async function prMergedBy(sha) {
    try {
      const { data } = await github.rest.repos.listPullRequestsAssociatedWithCommit({ ...current, commit_sha: sha });
      return data.find((p) => p.merge_commit_sha === sha) || null;
    } catch {
      return null;
    }
  }

  /** Effetto di una PR mergiata: descrizione + link manuali + messaggi dei suoi commit. */
  async function effectsOfPr(pr, depth, { includeCommits = true } = {}) {
    const rev = revertedPr(pr.body, current);
    if (rev) {
      if (depth >= MAX_REVERT_DEPTH) return [];
      try {
        const { data: inner } = await github.rest.pulls.get({ owner: rev.owner, repo: rev.repo, pull_number: rev.number });
        return invert(await effectsOfPr(inner, depth + 1));
      } catch (e) {
        core.warning(`PR annullata ${rev.owner}/${rev.repo}#${rev.number} non trovata: ${e.message}`);
        return [];
      }
    }
    const out = parseClosingRefs(pr.body, current).map((ref) => ({ ref, action: 'add' }));
    out.push(...(await manualLinks(pr)));
    if (includeCommits) {
      try {
        const commits = await github.paginate(github.rest.pulls.listCommits, { ...current, pull_number: pr.number, per_page: 100 });
        for (const c of commits) out.push(...(await effectsOfMessage(c.commit.message, depth)));
      } catch (e) {
        core.warning(`Impossibile leggere i commit della PR #${pr.number}: ${e.message}`);
      }
    }
    return out;
  }

  /** Issue collegate a mano dalla sidebar "Development" della PR. */
  async function manualLinks(pr) {
    try {
      const res = await github.graphql(
        `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$n){
           closingIssuesReferences(first:50){nodes{number repository{name owner{login}}}}}}}`,
        { owner: current.owner, repo: current.repo, n: pr.number }
      );
      const nodes = res.repository.pullRequest.closingIssuesReferences.nodes || [];
      return nodes.map((n) => {
        const ref = { owner: n.repository.owner.login, repo: n.repository.name, number: n.number };
        ref.key = `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;
        return { ref, action: 'add' };
      });
    } catch {
      return [];
    }
  }

  /** Commit arrivati con il push, in ordine cronologico (anche quelli entrati con un merge). */
  async function pushedCommits() {
    const p = context.payload;
    const fromPayload = (p.commits || []).map((c) => ({ sha: c.id, message: c.message }));
    if (!p.before || /^0+$/.test(p.before) || !p.after || /^0+$/.test(p.after)) return fromPayload;
    try {
      const all = [];
      for (let page = 1; page <= MAX_COMPARE_PAGES; page++) {
        const { data } = await github.rest.repos.compareCommitsWithBasehead({
          ...current, basehead: `${p.before}...${p.after}`, per_page: 100, page,
        });
        all.push(...data.commits.map((c) => ({ sha: c.sha, message: c.commit.message })));
        if (data.commits.length < 100) break;
      }
      return all;
    } catch (e) {
      core.warning(`Confronto ${p.before.slice(0, 7)}...${p.after.slice(0, 7)} fallito (${e.message}), uso il payload del push.`);
      return fromPayload;
    }
  }

  // ------------------------------------------------------------------- eventi
  const event = context.eventName;

  if (event === 'push') {
    const branch = String(context.ref || '').replace(/^refs\/heads\//, '');
    if (!context.ref.startsWith('refs/heads/')) return core.info('Push di un tag: niente da fare.');
    if (branch === defaultBranch) {
      return core.info(`"${branch}" è il branch di default: le issue le chiude GitHub, niente da fare.`);
    }
    for (const c of await pushedCommits()) {
      record(await effectsOfMessage(c.message, 0), `commit ${c.sha.slice(0, 7)}`);
    }
  } else if (event === 'pull_request' || event === 'pull_request_target') {
    const pr = context.payload.pull_request;
    if (context.payload.action !== 'closed' || !pr.merged) return core.info('PR non mergiata: niente da fare.');
    if (pr.base.ref === defaultBranch) return core.info('PR verso il branch di default: le issue le chiude GitHub.');
    // i commit della PR li gestisce già il trigger "push": qui solo descrizione e link manuali
    record(await effectsOfPr(pr, 0, { includeCommits: false }), `PR #${pr.number}`);
  } else {
    return core.warning(`Evento "${event}" non gestito: usa push e/o pull_request (closed).`);
  }

  // ------------------------------------------------------------- applicazione
  const labeled = [];
  const unlabeled = [];
  const skipped = [];
  const statusQueue = []; // { where, nodeId, option }
  const ensured = new Set();
  const hasLabel = (issue, name) =>
    (issue.labels || []).some((l) => (typeof l === 'string' ? l : l.name).toLowerCase() === name.toLowerCase());

  async function ensureLabel(owner, repo) {
    const k = `${owner}/${repo}`.toLowerCase();
    if (ensured.has(k)) return;
    try {
      await github.rest.issues.getLabel({ owner, repo, name: opts.label });
    } catch (e) {
      if (e.status !== 404) throw e;
      if (!opts.dryRun) {
        try {
          await github.rest.issues.createLabel({ owner, repo, name: opts.label, color: opts.color, description: opts.description });
          core.info(`Creata la label "${opts.label}" in ${owner}/${repo}.`);
        } catch (err) {
          if (err.status !== 422) throw err; // 422 = creata nel frattempo
        }
      }
    }
    ensured.add(k);
  }

  for (const { ref, action, source } of effects.values()) {
    const where = `${ref.owner}/${ref.repo}#${ref.number}`;
    let issue;
    try {
      ({ data: issue } = await github.rest.issues.get({ owner: ref.owner, repo: ref.repo, issue_number: ref.number }));
    } catch (e) {
      const other = ref.key.split('#')[0] !== `${current.owner}/${current.repo}`.toLowerCase();
      core.warning(
        `${where} (da ${source}) non accessibile: ${e.message}` +
          (other ? ' — per issue di altre repo serve un token con accesso a quella repo (input "token").' : '')
      );
      continue;
    }
    if (issue.pull_request) {
      core.info(`${where} è una pull request: ignorata.`);
      continue;
    }
    if (opts.skipLabel && hasLabel(issue, opts.skipLabel)) {
      skipped.push(where);
      core.info(`${where} ha "${opts.skipLabel}": ignorata.`);
      continue;
    }
    const has = hasLabel(issue, opts.label);

    try {
      if (action === 'add') {
        if (issue.state !== 'open') { core.info(`${where} è già chiusa: ignorata.`); continue; }
        if (has) { core.info(`${where} ha già "${opts.label}".`); continue; }
        await ensureLabel(ref.owner, ref.repo);
        if (!opts.dryRun) {
          await github.rest.issues.addLabels({ owner: ref.owner, repo: ref.repo, issue_number: ref.number, labels: [opts.label] });
        }
        labeled.push(where);
        if (opts.statusOnDevelop) statusQueue.push({ where, nodeId: issue.node_id, option: opts.statusOnDevelop });
        core.info(`${opts.dryRun ? '[dry-run] ' : ''}+ "${opts.label}" su ${where} (da ${source})`);
      } else {
        if (!has) continue;
        if (!opts.dryRun) {
          await github.rest.issues.removeLabel({ owner: ref.owner, repo: ref.repo, issue_number: ref.number, name: opts.label });
        }
        unlabeled.push(where);
        if (opts.statusOnRevert) statusQueue.push({ where, nodeId: issue.node_id, option: opts.statusOnRevert });
        core.info(`${opts.dryRun ? '[dry-run] ' : ''}- "${opts.label}" da ${where} (revert, da ${source})`);
      }
    } catch (e) {
      core.warning(`${where}: operazione fallita (${e.message}).`);
    }
  }

  // ---------------------------------------------------------------- project
  const moved = [];
  if (project) {
    for (const { where, nodeId, option } of statusQueue) {
      try {
        const r = await project.setStatus(nodeId, option, opts.dryRun);
        if (r === 'missing') {
          core.info(`${where} non è nel project "${project.title}": Status non toccato.`);
        } else {
          moved.push(`${where} -> ${option}`);
          core.info(`${opts.dryRun ? '[dry-run] ' : ''}${where}: ${opts.statusField} = "${option}"`);
        }
      } catch (e) {
        core.warning(`${where}: Status non aggiornato (${e.message})${tokenHint(e)}`);
      }
    }
  }

  core.setOutput('labeled', JSON.stringify(labeled));
  core.setOutput('unlabeled', JSON.stringify(unlabeled));
  core.setOutput('skipped', JSON.stringify(skipped));
  await core.summary
    .addHeading(`Label "${opts.label}"`, 3)
    .addList(
      [
        ...labeled.map((x) => `+ ${x}`),
        ...unlabeled.map((x) => `- ${x} (revert)`),
        ...skipped.map((x) => `skip ${x} ("${opts.skipLabel}")`),
        ...moved.map((x) => `project: ${x}`),
      ].concat(labeled.length + unlabeled.length + skipped.length ? [] : ['Nessuna modifica'])
    )
    .write()
    .catch(() => {});
};
