'use strict';

const { parseClosingRefs, revertedSha, revertedPr, messageTokens } = require('./parse');
const { openProject, tokenHint } = require('./project');
const { MARK_WARN, warnText, reopenText, revertedText, releasedText, hasMarker, findCloser } = require('./skip');

const MAX_REVERT_DEPTH = 5;
const MAX_COMPARE_PAGES = 30;

/**
 * Entry point, called by actions/github-script.
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
    statusOnReopen: (env.OD_STATUS_ON_REOPEN || '').trim(),
    reopen: !/^(0|false|no)$/i.test(env.OD_REOPEN_SKIPPED || 'true'),
    warn: !/^(0|false|no)$/i.test(env.OD_WARN_SKIPPED || 'true'),
    releaseCleanup: !/^(0|false|no)$/i.test(env.OD_RELEASE_CLEANUP || 'true'),
    reopenReverted: !/^(0|false|no)$/i.test(env.OD_REOPEN_REVERTED || 'true'),
  };
  const current = { owner: context.repo.owner, repo: context.repo.repo };
  // outputs always set, even on early exit (later steps compare them with '[]')
  core.setOutput('labeled', '[]');
  core.setOutput('unlabeled', '[]');
  core.setOutput('skipped', '[]');
  core.setOutput('reopened', '[]');
  core.setOutput('released', '[]');

  // project: validated first, so a wrong name stops everything before touching issues
  let project = null;
  if (opts.project) {
    if (!opts.statusOnDevelop && !opts.statusOnRevert && !opts.statusOnReopen) {
      throw new Error('"project-url" needs at least one of "status-on-develop", "status-on-revert", "status-on-reopen".');
    }
    const projectGh = opts.projectToken && getOctokit ? getOctokit(opts.projectToken) : github;
    project = await openProject(projectGh, {
      url: opts.project,
      fieldName: opts.statusField,
      options: [opts.statusOnDevelop, opts.statusOnRevert, opts.statusOnReopen],
    });
    core.info(`Project "${project.title}": ${opts.statusField} -> "${opts.statusOnDevelop || '-'}" / revert -> "${opts.statusOnRevert || '-'}"`);
  } else if (opts.statusOnDevelop || opts.statusOnRevert || opts.statusOnReopen) {
    throw new Error('"status-on-develop" / "status-on-revert" / "status-on-reopen" need "project-url".');
  }
  const defaultBranch = context.payload.repository && context.payload.repository.default_branch;

  /** key -> { ref, action: 'add' | 'remove', source } ; the last event wins */
  const effects = new Map();
  const record = (list, source) => {
    for (const e of list) effects.set(e.ref.key, { ...e, source });
  };

  // ---------------------------------------------------------------- helpers
  const invert = (list) => list.map((e) => ({ ...e, action: e.action === 'add' ? 'remove' : 'add' }));

  /**
   * Net change of a unit of work (a commit or a pull request) per issue, in order. An issue that
   * is both added and removed inside the unit (a fix and its revert) has no net change and is
   * dropped, so reverting the unit does not bring the fix back.
   */
  function net(list) {
    const first = new Map();
    const last = new Map();
    for (const e of list) {
      if (!first.has(e.ref.key)) first.set(e.ref.key, e);
      last.set(e.ref.key, e);
    }
    return [...last.values()].filter((e) => first.get(e.ref.key).action === e.action);
  }

  /** Repository of a pull request object, falling back to the current one. */
  const repoOf = (pr) =>
    pr && pr.base && pr.base.repo && pr.base.repo.owner
      ? { owner: pr.base.repo.owner.login, repo: pr.base.repo.name }
      : current;

  /**
   * Effects of a commit message, in text order: "Fixes #N" -> add, "This reverts commit X" ->
   * inverse of the net effect of X. A squash message can contain both.
   */
  async function effectsOfMessage(message, depth, where = current) {
    const out = [];
    for (const t of messageTokens(message)) {
      if (t.revert) {
        if (depth >= MAX_REVERT_DEPTH) continue;
        out.push(...invert(net(await effectsOfSha(t.revert, depth + 1, where))));
      } else {
        out.push(...parseClosingRefs(t.text, where).map((ref) => ({ ref, action: 'add' })));
      }
    }
    return out;
  }

  /** Like effectsOfMessage but from a SHA; merge commits include the whole pull request. */
  async function effectsOfSha(sha, depth, where = current) {
    let data;
    try {
      ({ data } = await github.rest.repos.getCommit({ ...where, ref: sha }));
    } catch (e) {
      core.warning(`Commit ${sha.slice(0, 7)} reverted by a revert commit not found: ${e.message}`);
      return [];
    }
    const out = await effectsOfMessage(data.commit.message, depth, where);
    if ((data.parents || []).length > 1 && !revertedSha(data.commit.message)) {
      // revert of a merge commit: undoes everything the pull request brought in
      const pr = await prMergedBy(data.sha, where);
      if (pr) out.push(...(await effectsOfPr(pr, depth)));
    }
    return out;
  }

  async function prMergedBy(sha, where = current) {
    try {
      const { data } = await github.rest.repos.listPullRequestsAssociatedWithCommit({ ...where, commit_sha: sha });
      return data.find((p) => p.merge_commit_sha === sha) || null;
    } catch {
      return null;
    }
  }

  /** Effect of a merged pull request: description + manual links + its commit messages. */
  async function effectsOfPr(pr, depth, { includeCommits = true } = {}) {
    const where = repoOf(pr);
    const rev = revertedPr(pr.body, where);
    if (rev) {
      if (depth >= MAX_REVERT_DEPTH) return [];
      try {
        const { data: inner } = await github.rest.pulls.get({ owner: rev.owner, repo: rev.repo, pull_number: rev.number });
        if (!inner.base) inner.base = { repo: { owner: { login: rev.owner }, name: rev.repo } };
        return invert(net(await effectsOfPr(inner, depth + 1)));
      } catch (e) {
        core.warning(`Reverted pull request ${rev.owner}/${rev.repo}#${rev.number} not found: ${e.message}`);
        return [];
      }
    }
    const out = parseClosingRefs(pr.body, where, { markdown: true }).map((ref) => ({ ref, action: 'add' }));
    out.push(...(await manualLinks(pr, where)));
    if (includeCommits) {
      try {
        const commits = await github.paginate(github.rest.pulls.listCommits, { ...where, pull_number: pr.number, per_page: 100 });
        for (const c of commits) out.push(...(await effectsOfMessage(c.commit.message, depth, where)));
      } catch (e) {
        core.warning(`Cannot read the commits of pull request #${pr.number}: ${e.message}`);
      }
    }
    return out;
  }

  /** Issues linked by hand from the pull request "Development" sidebar. */
  async function manualLinks(pr, where = current) {
    try {
      const res = await github.graphql(
        `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$n){
           closingIssuesReferences(first:50){nodes{number repository{name owner{login}}}}}}}`,
        { owner: where.owner, repo: where.repo, n: pr.number }
      );
      const nodes = res.repository.pullRequest.closingIssuesReferences.nodes || [];
      if (nodes.length >= 50) core.warning(`Pull request #${pr.number}: only the first 50 linked issues were checked.`);
      return nodes.map((n) => {
        const ref = { owner: n.repository.owner.login, repo: n.repository.name, number: n.number };
        ref.key = `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;
        return { ref, action: 'add' };
      });
    } catch {
      return [];
    }
  }

  /** Commits brought by the push, oldest first (including those brought in by a merge). */
  async function pushedCommits() {
    const p = context.payload;
    const fromPayload = (p.commits || []).map((c) => ({ sha: c.id, message: c.message, parents: 0 }));
    const payloadOnly = (why) => {
      core.warning(`${why}: only the ${fromPayload.length} commits listed in the push event were checked, without pull request descriptions.`);
      return fromPayload;
    };
    if (!p.after || /^0+$/.test(p.after)) return [];
    if (!p.before || /^0+$/.test(p.before)) return payloadOnly('New branch');
    try {
      const all = [];
      for (let page = 1; page <= MAX_COMPARE_PAGES; page++) {
        const { data } = await github.rest.repos.compareCommitsWithBasehead({
          ...current, basehead: `${p.before}...${p.after}`, per_page: 100, page,
        });
        all.push(...data.commits.map((c) => ({ sha: c.sha, message: c.commit.message, parents: (c.parents || []).length })));
        if (data.commits.length < 100) break;
        if (page === MAX_COMPARE_PAGES) core.warning(`Push with more than ${MAX_COMPARE_PAGES * 100} commits: only the first ${MAX_COMPARE_PAGES * 100} were checked.`);
      }
      return all;
    } catch (e) {
      return payloadOnly(`Compare ${p.before.slice(0, 7)}...${p.after.slice(0, 7)} failed (${e.message})`);
    }
  }

  // -------------------------------------------------------------------- events
  const event = context.eventName;
  let targetBranch = '';

  if (event === 'issues') {
    return handleClosedIssue();
  }

  if (event === 'push') {
    const branch = String(context.ref || '').replace(/^refs\/heads\//, '');
    if (!context.ref.startsWith('refs/heads/')) return core.info('Tag push: nothing to do.');
    if (branch === defaultBranch) {
      if (!opts.releaseCleanup) return core.info(`"${branch}" is the default branch and "release-cleanup" is off: nothing to do.`);
      if (context.payload.forced) return core.warning(`Forced push to "${branch}": release cleanup skipped, check the issues by hand.`);
      return handleRelease(branch);
    }
    targetBranch = branch;
    for (const c of await pushedCommits()) {
      record(await effectsOfMessage(c.message, 0), `commit ${c.sha.slice(0, 7)}`);
    }
  } else if (event === 'pull_request' || event === 'pull_request_target') {
    const pr = context.payload.pull_request;
    if (context.payload.action !== 'closed' || !pr.merged) return core.info('Pull request not merged: nothing to do.');
    if (pr.base.ref === defaultBranch) return core.info('Pull request to the default branch: GitHub closes the issues.');
    targetBranch = pr.base.ref;
    // the pull request commits are handled by the "push" trigger: here only description and manual links
    record(await effectsOfPr(pr, 0, { includeCommits: false }), `PR #${pr.number}`);
  } else {
    return core.warning(`Event "${event}" not handled: use push, pull_request_target (closed) and issues (closed).`);
  }

  function labelNamed(issue, name) {
    return Boolean(name) && (issue.labels || []).some((l) => (typeof l === 'string' ? l : l.name).toLowerCase() === name.toLowerCase());
  }

  async function setStatusSafe(where, nodeId, option) {
    if (!project || !option) return;
    try {
      const r = await project.setStatus(nodeId, option, opts.dryRun);
      core.info(r === 'missing' ? `${where} is not in the project: status left unchanged.` : `${where}: ${opts.statusField} = "${option}"`);
    } catch (e) {
      core.warning(`${where}: status not updated (${e.message})${tokenHint(e)}`);
    }
  }

  async function reopenWith(issue, where, body) {
    if (opts.dryRun) return;
    await github.rest.issues.update({ ...current, issue_number: issue.number, state: 'open' });
    await github.rest.issues.createComment({ ...current, issue_number: issue.number, body });
  }

  /**
   * Was the fix in commit `sha` for issue `number` reverted later on the default branch?
   * Returns the short SHA of the commit that undid it, or null.
   */
  async function revertedOnDefault(sha, number) {
    const key = `${current.owner}/${current.repo}#${number}`.toLowerCase();
    let state = 'add';
    let by = null;
    // the closer can be the revert itself: git's revert subject repeats the keywords
    // (Revert "Fix crash, fixes #5") and GitHub closes the issue because of it
    const { data: closerCommit } = await github.rest.repos.getCommit({ ...current, ref: sha });
    for (const e of await effectsOfMessage(closerCommit.commit.message, 0)) {
      if (e.ref.key === key) { state = e.action; by = sha.slice(0, 7); }
    }
    for (let page = 1; page <= MAX_COMPARE_PAGES; page++) {
      const { data } = await github.rest.repos.compareCommitsWithBasehead({
        ...current, basehead: `${sha}...${defaultBranch}`, per_page: 100, page,
      });
      for (const c of data.commits) {
        for (const e of await effectsOfMessage(c.commit.message, 0)) {
          if (e.ref.key === key) { state = e.action; by = c.sha.slice(0, 7); }
        }
      }
      if (data.commits.length < 100) break;
    }
    return state === 'remove' ? by : null;
  }

  // ------------------------------------------------------------- closed issue
  async function handleClosedIssue() {
    const issue = context.payload.issue;
    if (context.payload.action !== 'closed' || !issue) return core.info('Issues event other than "closed": nothing to do.');
    const where = `${current.owner}/${current.repo}#${issue.number}`;
    if (issue.pull_request) return core.info(`${where} is a pull request: ignored.`);

    if (labelNamed(issue, opts.skipLabel)) {
      if (!opts.reopen) return core.info(`${where} has "${opts.skipLabel}" but "reopen-skipped" is off.`);
      let closer;
      try {
        closer = await findCloser(github, { ...current, number: issue.number });
      } catch (e) {
        return core.warning(`${where}: cannot find what closed it (${e.message}): left closed.`);
      }
      if (!closer) return core.info(`${where} was closed by hand: left closed.`);
      await reopenWith(issue, where, reopenText({ skipLabel: opts.skipLabel, closer: closer.text }));
      core.warning(`${opts.dryRun ? '[dry-run] ' : ''}${where} reopened: it has "${opts.skipLabel}" and was closed by ${closer.text}.`);
      await setStatusSafe(where, issue.node_id, opts.statusOnReopen);
      core.setOutput('reopened', JSON.stringify([where]));
      await core.summary.addHeading('Reopened', 3).addList([`${where} (closed by ${closer.text})`]).write().catch(() => {});
      return;
    }

    if (!opts.reopenReverted) return core.info(`${where}: "reopen-reverted" is off, nothing to do.`);
    let closer;
    let reverter;
    try {
      closer = await findCloser(github, { ...current, number: issue.number });
      if (!closer || !closer.sha) return core.info(`${where} was not closed by a commit: nothing to do.`);
      reverter = await revertedOnDefault(closer.sha, issue.number);
    } catch (e) {
      return core.warning(`${where}: cannot check whether its fix was reverted (${e.message}): left closed.`);
    }
    if (!reverter) return core.info(`${where} was closed by ${closer.text}, which was not reverted: left closed.`);
    await reopenWith(issue, where, revertedText({ closer: closer.text, reverter }));
    core.warning(`${opts.dryRun ? '[dry-run] ' : ''}${where} reopened: ${closer.text} was reverted by commit ${reverter}.`);
    await setStatusSafe(where, issue.node_id, opts.statusOnRevert);
    core.setOutput('reopened', JSON.stringify([where]));
    await core.summary.addHeading('Reopened', 3).addList([`${where} (${closer.text} reverted by ${reverter})`]).write().catch(() => {});
  }

  // ------------------------------------------------- release (default branch)
  async function handleRelease(branch) {
    const after = String(context.payload.after || '').slice(0, 7);
    const rel = new Map();
    const put = (list, source) => { for (const e of list) rel.set(e.ref.key, { ...e, source }); };
    for (const c of await pushedCommits()) {
      put(await effectsOfMessage(c.message, 0), `commit ${c.sha.slice(0, 7)}`);
      if (c.parents > 1 && !revertedSha(c.message)) {
        const pr = await prMergedBy(c.sha);
        if (pr) put(await effectsOfPr(pr, 0, { includeCommits: false }), `pull request #${pr.number}`);
      }
    }
    const released = [];
    const cleaned = [];
    for (const { ref, action, source } of rel.values()) {
      if (action !== 'add') continue;
      const where = `${ref.owner}/${ref.repo}#${ref.number}`;
      let issue;
      try {
        ({ data: issue } = await github.rest.issues.get({ owner: ref.owner, repo: ref.repo, issue_number: ref.number }));
      } catch (e) {
        core.warning(`${where} (from ${source}) not accessible: ${e.message}`);
        continue;
      }
      if (issue.pull_request) continue;
      if (labelNamed(issue, opts.skipLabel)) { core.info(`${where} has "${opts.skipLabel}": ignored.`); continue; }
      try {
        // commits with a closing keyword are closed by GitHub itself; pull request descriptions
        // and manual links of pull requests merged into develop are not, so close those here
        // only issues that got the label when the pull request was merged: its description can be
        // edited after the merge, so it is not trusted on its own
        if (issue.state === 'open' && source.startsWith('pull request') && labelNamed(issue, opts.label)) {
          if (!opts.dryRun) {
            await github.rest.issues.update({ owner: ref.owner, repo: ref.repo, issue_number: ref.number, state: 'closed', state_reason: 'completed' });
            await github.rest.issues.createComment({
              owner: ref.owner, repo: ref.repo, issue_number: ref.number, body: releasedText({ source, branch, sha: after }),
            });
          }
          released.push(where);
          core.info(`${opts.dryRun ? '[dry-run] ' : ''}closed ${where} (fixed by ${source}, released in ${after})`);
        }
        if (labelNamed(issue, opts.label)) {
          if (!opts.dryRun) {
            try {
              await github.rest.issues.removeLabel({ owner: ref.owner, repo: ref.repo, issue_number: ref.number, name: opts.label });
            } catch (e) {
              if (e.status !== 404) throw e;
            }
          }
          cleaned.push(where);
          core.info(`${opts.dryRun ? '[dry-run] ' : ''}- "${opts.label}" from ${where} (released)`);
        }
      } catch (e) {
        core.warning(`${where}: operation failed (${e.message}).`);
      }
    }
    core.setOutput('released', JSON.stringify(released));
    core.setOutput('unlabeled', JSON.stringify(cleaned));
    await core.summary
      .addHeading(`Release to ${branch}`, 3)
      .addList([...released.map((x) => `closed ${x}`), ...cleaned.map((x) => `- "${opts.label}" ${x}`)].concat(released.length + cleaned.length ? [] : ['No changes']))
      .write()
      .catch(() => {});
  }

  // ------------------------------------------------------------------ apply
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
          core.info(`Created label "${opts.label}" in ${owner}/${repo}.`);
        } catch (err) {
          if (err.status !== 422) throw err; // 422 = created meanwhile
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
        `${where} (from ${source}) not accessible: ${e.message}` +
          (other ? ' — issues in other repositories need a token with access to them (input "token").' : '')
      );
      continue;
    }
    if (issue.pull_request) {
      core.info(`${where} is a pull request: ignored.`);
      continue;
    }
    if (opts.skipLabel && hasLabel(issue, opts.skipLabel)) {
      skipped.push(where);
      core.info(`${where} has "${opts.skipLabel}": ignored.`);
      if (action === 'add' && issue.state === 'open' && opts.warn) {
        core.warning(`${where} has "${opts.skipLabel}" but ${source} will close it at release.`);
        try {
          if (!(await hasMarker(github, ref, MARK_WARN)) && !opts.dryRun) {
            await github.rest.issues.createComment({
              owner: ref.owner, repo: ref.repo, issue_number: ref.number,
              body: warnText({ skipLabel: opts.skipLabel, source, branch: targetBranch, number: ref.number, reopen: opts.reopen }),
            });
          }
        } catch (e) {
          core.warning(`${where}: warning comment not written (${e.message}).`);
        }
      }
      continue;
    }
    const has = hasLabel(issue, opts.label);

    try {
      if (action === 'add') {
        if (issue.state !== 'open') { core.info(`${where} is already closed: ignored.`); continue; }
        if (has) { core.info(`${where} already has "${opts.label}".`); continue; }
        await ensureLabel(ref.owner, ref.repo);
        if (!opts.dryRun) {
          await github.rest.issues.addLabels({ owner: ref.owner, repo: ref.repo, issue_number: ref.number, labels: [opts.label] });
        }
        labeled.push(where);
        if (opts.statusOnDevelop) statusQueue.push({ where, nodeId: issue.node_id, option: opts.statusOnDevelop });
        core.info(`${opts.dryRun ? '[dry-run] ' : ''}+ "${opts.label}" on ${where} (from ${source})`);
      } else {
        if (!has) continue;
        if (!opts.dryRun) {
          try {
            await github.rest.issues.removeLabel({ owner: ref.owner, repo: ref.repo, issue_number: ref.number, name: opts.label });
          } catch (e) {
            // 404 = already removed, e.g. by a concurrent run for the same merge
            if (e.status !== 404) throw e;
          }
        }
        unlabeled.push(where);
        if (opts.statusOnRevert) statusQueue.push({ where, nodeId: issue.node_id, option: opts.statusOnRevert });
        core.info(`${opts.dryRun ? '[dry-run] ' : ''}- "${opts.label}" from ${where} (revert, from ${source})`);
      }
    } catch (e) {
      core.warning(`${where}: operation failed (${e.message}).`);
    }
  }

  // ---------------------------------------------------------------- project
  const moved = [];
  if (project) {
    for (const { where, nodeId, option } of statusQueue) {
      try {
        const r = await project.setStatus(nodeId, option, opts.dryRun);
        if (r === 'missing') {
          core.info(`${where} is not in project "${project.title}": status left unchanged.`);
        } else {
          moved.push(`${where} -> ${option}`);
          core.info(`${opts.dryRun ? '[dry-run] ' : ''}${where}: ${opts.statusField} = "${option}"`);
        }
      } catch (e) {
        core.warning(`${where}: status not updated (${e.message})${tokenHint(e)}`);
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
      ].concat(labeled.length + unlabeled.length + skipped.length ? [] : ['No changes'])
    )
    .write()
    .catch(() => {});
};
