'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const run = require('../src/main');

const err = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

function world({ issues = {}, commits = {}, prs = {}, compare = [], repoLabels = [] } = {}) {
  const st = { issues: structuredClone(issues), repoLabels: new Set(repoLabels), created: [], comments: {}, updates: [], closer: {}, events: {}, graphqlDown: false };
  const issueOf = (o, r, n) => st.issues[`${o}/${r}#${n}`.toLowerCase()];
  const github = {
    rest: {
      issues: {
        get: async ({ owner, repo, issue_number }) => {
          const i = issueOf(owner, repo, issue_number);
          if (!i || i.forbidden) throw err(404);
          return { data: { ...i, node_id: `node-${owner}/${repo}#${issue_number}`, labels: i.labels.map((name) => ({ name })) } };
        },
        getLabel: async ({ owner, repo, name }) => {
          if (!st.repoLabels.has(`${owner}/${repo}:${name}`)) throw err(404);
          return { data: {} };
        },
        createLabel: async ({ owner, repo, name }) => { st.repoLabels.add(`${owner}/${repo}:${name}`); st.created.push(`${owner}/${repo}`); },
        addLabels: async ({ owner, repo, issue_number, labels }) => { issueOf(owner, repo, issue_number).labels.push(...labels); },
        listComments: 'listComments',
        listEvents: 'listEvents',
        createComment: async ({ issue_number, body }) => { (st.comments[issue_number] ||= []).push({ body }); },
        update: async ({ owner, repo, issue_number, state }) => { issueOf(owner, repo, issue_number).state = state; st.updates.push(`${issue_number}:${state}`); },
        removeLabel: async ({ owner, repo, issue_number, name }) => {
          const i = issueOf(owner, repo, issue_number);
          i.labels = i.labels.filter((l) => l !== name);
        },
      },
      repos: {
        getCommit: async ({ ref }) => {
          const c = commits[ref];
          if (!c) throw err(404);
          return { data: { sha: ref, commit: { message: c.message }, parents: c.parents || [{}] } };
        },
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({
          data: Object.values(prs).filter((p) => p.merge_commit_sha === commit_sha),
        }),
        compareCommitsWithBasehead: async () => ({
          data: { commits: compare.map((c) => ({ sha: c.sha, commit: { message: c.message } })) },
        }),
      },
      pulls: {
        get: async ({ pull_number }) => { if (!prs[pull_number]) throw err(404); return { data: prs[pull_number] }; },
        listCommits: 'listCommits',
      },
    },
    paginate: async (fn, args) => {
      if (fn === 'listComments') return st.comments[args.issue_number] || [];
      if (fn === 'listEvents') return st.events[args.issue_number] || [];
      return (prs[args.pull_number].commits || []).map((message) => ({ commit: { message } }));
    },
    graphql: async (q, v) => {
      if (q.includes('timelineItems')) {
        if (st.graphqlDown) throw new Error('graphql down');
        const c = st.closer[v.n];
        return { repository: { issue: { timelineItems: { nodes: [{ closer: c || null }] } } } };
      }
      return { repository: { pullRequest: { closingIssuesReferences: { nodes: [] } } } };
    },
  };
  const logs = [];
  const core = {
    info: (m) => logs.push(m), warning: (m) => logs.push('WARN ' + m),
    setOutput: (k, v) => { st[k] = JSON.parse(v); },
    summary: { addHeading() { return this; }, addList() { return this; }, write: async () => {} },
  };
  return { github, core, st, logs };
}

const repoCtx = { owner: 'alanmasu', repo: 'app' };
const push = (branch, extra = {}) => ({
  eventName: 'push', ref: `refs/heads/${branch}`, repo: repoCtx,
  payload: { repository: { default_branch: 'main' }, before: 'b'.repeat(40), after: 'a'.repeat(40), ...extra },
});
const prEvent = (pr) => ({
  eventName: 'pull_request', ref: '', repo: repoCtx,
  payload: { action: 'closed', repository: { default_branch: 'main' }, pull_request: { merged: true, base: { ref: 'develop' }, ...pr } },
});
const open = (labels = []) => ({ state: 'open', labels });

test('push su develop: etichetta solo le issue aperte e accessibili', async () => {
  const w = world({
    issues: {
      'alanmasu/app#1': open(), 'alanmasu/app#3': { state: 'closed', labels: [] },
      'alanmasu/app#4': { ...open(), pull_request: {} }, 'other/lib#2': { ...open(), forbidden: true },
    },
    compare: [
      { sha: 'c1'.padEnd(40, '0'), message: 'Login: fixes #1' },
      { sha: 'c2'.padEnd(40, '0'), message: 'Fixes other/lib#2\n\nresolves #3, closes #4' },
    ],
  });
  await run({ github: w.github, core: w.core, context: push('develop'), env: {} });
  assert.deepEqual(w.st.labeled, ['alanmasu/app#1']);
  assert.deepEqual(w.st.issues['alanmasu/app#1'].labels, ['on develop']);
  assert.deepEqual(w.st.created, ['alanmasu/app']);
  assert.ok(w.logs.some((l) => l.startsWith('WARN other/lib#2') && l.includes('token')));
});

test('revert: toglie la label e non legge la keyword nel titolo del revert', async () => {
  const w = world({
    issues: { 'alanmasu/app#1': open(['on develop']) },
    commits: { aaaaaaa: { message: 'Login, fixes #1' } },
    compare: [{ sha: 'r'.repeat(40), message: 'Revert "Login, fixes #1"\n\nThis reverts commit aaaaaaa.' }],
  });
  await run({ github: w.github, core: w.core, context: push('develop'), env: {} });
  assert.deepEqual(w.st.unlabeled, ['alanmasu/app#1']);
  assert.deepEqual(w.st.issues['alanmasu/app#1'].labels, []);
});

test('fix e revert nello stesso push: vince l\'ultimo', async () => {
  const w = world({
    issues: { 'alanmasu/app#1': open() },
    commits: { aaaaaaa: { message: 'fixes #1' } },
    compare: [
      { sha: 'aaaaaaa'.padEnd(40, '0'), message: 'fixes #1' },
      { sha: 'r'.repeat(40), message: 'Revert "fixes #1"\n\nThis reverts commit aaaaaaa.' },
    ],
  });
  await run({ github: w.github, core: w.core, context: push('develop'), env: {} });
  assert.deepEqual(w.st.issues['alanmasu/app#1'].labels, []);
});

test('revert del revert: la label torna', async () => {
  const w = world({
    issues: { 'alanmasu/app#1': open() },
    commits: {
      aaaaaaa: { message: 'fixes #1' },
      bbbbbbb: { message: 'Revert "fixes #1"\n\nThis reverts commit aaaaaaa.' },
    },
    compare: [{ sha: 'c'.repeat(40), message: 'Revert "Revert "fixes #1""\n\nThis reverts commit bbbbbbb.' }],
  });
  await run({ github: w.github, core: w.core, context: push('develop'), env: {} });
  assert.deepEqual(w.st.issues['alanmasu/app#1'].labels, ['on develop']);
});

test('revert di un merge commit: annulla tutta la PR', async () => {
  const w = world({
    issues: { 'alanmasu/app#5': open(['on develop']), 'alanmasu/app#6': open(['on develop']) },
    commits: { abcdef0: { message: 'Merge pull request #20 from alanmasu/feat', parents: [{}, {}] } },
    prs: { 20: { number: 20, merge_commit_sha: 'abcdef0', body: 'Closes #5', commits: ['fix: x, fixes #6'] } },
    compare: [{ sha: 'r'.repeat(40), message: 'Revert "Merge pull request #20"\n\nThis reverts commit abcdef0, reversing\nchanges made to 1234567.' }],
  });
  await run({ github: w.github, core: w.core, context: push('develop'), env: {} });
  assert.deepEqual(w.st.unlabeled.sort(), ['alanmasu/app#5', 'alanmasu/app#6']);
});

test('push sul branch di default: non fa nulla', async () => {
  const w = world({ issues: { 'alanmasu/app#1': open() }, compare: [{ sha: 'x'.repeat(40), message: 'fixes #1' }] });
  await run({ github: w.github, core: w.core, context: push('main'), env: {} });
  assert.deepEqual(w.st.issues['alanmasu/app#1'].labels, []);
});

test('PR mergiata in develop: descrizione; PR di revert: toglie', async () => {
  const w = world({
    issues: { 'alanmasu/app#7': open(), 'alanmasu/app#8': open(['on develop']) },
    prs: { 30: { number: 30, body: 'Closes #8' } },
  });
  await run({ github: w.github, core: w.core, context: prEvent({ number: 31, body: '<!-- Fixes #99 -->\nCloses #7' }), env: {} });
  assert.deepEqual(w.st.labeled, ['alanmasu/app#7']);
  await run({ github: w.github, core: w.core, context: prEvent({ number: 32, body: 'Reverts alanmasu/app#30' }), env: {} });
  assert.deepEqual(w.st.unlabeled, ['alanmasu/app#8']);
});

test('label personalizzata e dry-run', async () => {
  const w = world({ issues: { 'alanmasu/app#1': open() }, compare: [{ sha: 'x'.repeat(40), message: 'fixes #1' }] });
  await run({ github: w.github, core: w.core, context: push('develop'), env: { OD_LABEL: 'in staging', OD_DRY_RUN: 'true' } });
  assert.deepEqual(w.st.labeled, ['alanmasu/app#1']);
  assert.deepEqual(w.st.issues['alanmasu/app#1'].labels, []);
  assert.deepEqual(w.st.created, []);
});

function projectOctokit({ inProject = [] } = {}) {
  const calls = [];
  const gh = {
    graphql: async (q, v) => {
      if (q.includes('projectV2(number')) {
        return { owner: { projectV2: { id: 'P1', title: 'Board', fields: { nodes: [
          { id: 'F1', name: 'Status', dataType: 'SINGLE_SELECT', options: [
            { id: 'o-prog', name: 'In progress' }, { id: 'o-dev', name: 'On develop' }, { id: 'o-done', name: 'Done' }] },
          { id: 'F2', name: 'Estimate', dataType: 'NUMBER' }] } } } };
      }
      if (q.includes('node(id')) {
        const has = inProject.includes(v.id.replace('node-', ''));
        return { node: { projectItems: { nodes: has ? [{ id: `item-${v.id}`, project: { id: 'P1' } }] : [] } } };
      }
      if (q.includes('updateProjectV2ItemFieldValue')) { calls.push(`${v.i} ${v.f}=${v.o}`); return {}; }
      throw new Error('query inattesa: ' + q.slice(0, 40));
    },
  };
  return { gh, calls, getOctokit: (token) => { calls.push(`token:${token}`); return gh; } };
}
const projEnv = (extra = {}) => ({
  OD_PROJECT_URL: 'https://github.com/orgs/ThinkEmbedded-dev/projects/1', OD_PROJECT_TOKEN: 'pat',
  OD_STATUS_ON_DEVELOP: 'On develop', OD_STATUS_ON_REVERT: 'In progress', ...extra });

test('skip-label: issue ignorata, nessuna label', async () => {
  const w = world({
    issues: { 'alanmasu/app#1': open(['do not close']), 'alanmasu/app#2': open() },
    compare: [{ sha: 'x'.repeat(40), message: 'fixes #1, fixes #2' }],
  });
  await run({ github: w.github, core: w.core, context: push('develop'), env: { OD_SKIP_LABEL: 'Do Not Close' } });
  assert.deepEqual(w.st.labeled, ['alanmasu/app#2']);
  assert.deepEqual(w.st.skipped, ['alanmasu/app#1']);
  assert.deepEqual(w.st.issues['alanmasu/app#1'].labels, ['do not close']);
});

test('project: Status su develop e su revert, solo per elementi nel project', async () => {
  const p = projectOctokit({ inProject: ['alanmasu/app#1', 'alanmasu/app#3'] });
  const w = world({
    issues: { 'alanmasu/app#1': open(), 'alanmasu/app#2': open(), 'alanmasu/app#3': open(['on develop']) },
    commits: { abcdef1: { message: 'fixes #3' } },
    compare: [
      { sha: 'a'.repeat(40), message: 'fixes #1, fixes #2' },
      { sha: 'r'.repeat(40), message: 'Revert "fixes #3"\n\nThis reverts commit abcdef1.' },
    ],
  });
  await run({ github: w.github, core: w.core, context: push('develop'), getOctokit: p.getOctokit, env: projEnv() });
  assert.deepEqual(p.calls, ['token:pat', 'item-node-alanmasu/app#1 F1=o-dev', 'item-node-alanmasu/app#3 F1=o-prog']);
  assert.ok(w.logs.some((l) => l.includes('alanmasu/app#2 is not in project')));
});

test('project: errori di configurazione fermano tutto prima di toccare le issue', async () => {
  const p = projectOctokit();
  const w = world({ issues: { 'alanmasu/app#1': open() }, compare: [{ sha: 'a'.repeat(40), message: 'fixes #1' }] });
  const go = (env) => run({ github: w.github, core: w.core, context: push('develop'), getOctokit: p.getOctokit, env });
  await assert.rejects(go(projEnv({ OD_STATUS_ON_DEVELOP: 'Merged' })), /Option "Merged" does not exist.*In progress, On develop, Done/);
  await assert.rejects(go(projEnv({ OD_STATUS_FIELD: 'Estimate' })), /type NUMBER/);
  await assert.rejects(go(projEnv({ OD_STATUS_FIELD: 'Fase' })), /Field "Fase" does not exist/);
  await assert.rejects(go(projEnv({ OD_STATUS_ON_DEVELOP: '', OD_STATUS_ON_REVERT: '' })), /at least one/);
  await assert.rejects(go({ OD_STATUS_ON_DEVELOP: 'On develop' }), /need "project-url"/);
  assert.deepEqual(w.st.issues['alanmasu/app#1'].labels, []);
});

test('project: dry-run non sposta nulla', async () => {
  const p = projectOctokit({ inProject: ['alanmasu/app#1'] });
  const w = world({ issues: { 'alanmasu/app#1': open() }, compare: [{ sha: 'a'.repeat(40), message: 'fixes #1' }] });
  await run({ github: w.github, core: w.core, context: push('develop'), getOctokit: p.getOctokit, env: projEnv({ OD_DRY_RUN: 'true' }) });
  assert.deepEqual(p.calls, ['token:pat']);
});

test('revert concorrente: label già tolta non è un errore', async () => {
  const w = world({
    issues: { 'alanmasu/app#1': open(['on develop']) },
    commits: { abcdef1: { message: 'fixes #1' } },
    compare: [{ sha: 'r'.repeat(40), message: 'Revert "fixes #1"\n\nThis reverts commit abcdef1.' }],
  });
  w.github.rest.issues.removeLabel = async () => { throw Object.assign(new Error('Label does not exist'), { status: 404 }); };
  await run({ github: w.github, core: w.core, context: push('develop'), env: {} });
  assert.ok(!w.logs.some((l) => l.startsWith('WARN')));
  assert.deepEqual(w.st.unlabeled, ['alanmasu/app#1']);
});

const closedEvent = (number, labels) => ({
  eventName: 'issues', ref: '', repo: repoCtx,
  payload: { action: 'closed', repository: { default_branch: 'main' },
    issue: { number, node_id: `node-${number}`, labels: labels.map((name) => ({ name })) } },
});

test('avviso: commento una sola volta quando un Fixes arriva su una issue "do not close"', async () => {
  const w = world({
    issues: { 'alanmasu/app#6': open(['do not close']) },
    compare: [{ sha: 'a'.repeat(40), message: 'fixes #6' }],
  });
  const env = { OD_SKIP_LABEL: 'do not close' };
  await run({ github: w.github, core: w.core, context: push('develop'), env });
  await run({ github: w.github, core: w.core, context: push('develop'), env });
  assert.equal(w.st.comments[6].length, 1);
  assert.match(w.st.comments[6][0].body, /commit aaaaaaa on `develop`.*\n.*reopened automatically/);
  assert.match(w.st.comments[6][0].body, /Use `Refs #6` instead of `Fixes #6`/);
  assert.ok(w.logs.some((l) => l.startsWith('WARN') && l.includes('#6')));
});

test('avviso disattivato o issue chiusa: nessun commento', async () => {
  const w = world({
    issues: { 'alanmasu/app#6': open(['do not close']), 'alanmasu/app#7': { state: 'closed', labels: ['do not close'] } },
    compare: [{ sha: 'a'.repeat(40), message: 'fixes #6, fixes #7' }],
  });
  await run({ github: w.github, core: w.core, context: push('develop'), env: { OD_SKIP_LABEL: 'do not close', OD_WARN_SKIPPED: 'false' } });
  assert.deepEqual(w.st.comments, {});
  await run({ github: w.github, core: w.core, context: push('develop'), env: { OD_SKIP_LABEL: 'do not close' } });
  assert.deepEqual(Object.keys(w.st.comments), ['6']);
});

test('riapertura: chiusa da commit o da PR -> riaperta con commento', async () => {
  for (const [closer, text] of [[{ __typename: 'Commit', abbreviatedOid: 'abc1234' }, 'commit abc1234'],
                                 [{ __typename: 'PullRequest', number: 12 }, 'pull request #12']]) {
    const w = world({ issues: { 'alanmasu/app#6': { state: 'closed', labels: ['do not close'] } } });
    w.st.closer[6] = closer;
    await run({ github: w.github, core: w.core, context: closedEvent(6, ['do not close']), env: { OD_SKIP_LABEL: 'do not close' } });
    assert.deepEqual(w.st.updates, ['6:open']);
    assert.match(w.st.comments[6][0].body, new RegExp(`closed by ${text}\\.`));
    assert.deepEqual(w.st.reopened, ['alanmasu/app#6']);
  }
});

test('riapertura: chiusa a mano, senza label o disattivata -> resta chiusa', async () => {
  const w = world({ issues: { 'alanmasu/app#6': { state: 'closed', labels: ['do not close'] }, 'alanmasu/app#7': { state: 'closed', labels: [] } } });
  await run({ github: w.github, core: w.core, context: closedEvent(6, ['do not close']), env: { OD_SKIP_LABEL: 'do not close' } });
  w.st.closer[7] = { __typename: 'Commit', abbreviatedOid: 'abc1234' };
  await run({ github: w.github, core: w.core, context: closedEvent(7, []), env: { OD_SKIP_LABEL: 'do not close' } });
  w.st.closer[6] = { __typename: 'Commit', abbreviatedOid: 'abc1234' };
  await run({ github: w.github, core: w.core, context: closedEvent(6, ['do not close']), env: { OD_SKIP_LABEL: 'do not close', OD_REOPEN_SKIPPED: 'false' } });
  assert.deepEqual(w.st.updates, []);
  assert.ok(w.logs.some((l) => l.includes('closed by hand')));
});

test('riapertura: fallback REST se GraphQL non risponde', async () => {
  const w = world({ issues: { 'alanmasu/app#6': { state: 'closed', labels: ['do not close'] } } });
  w.st.graphqlDown = true;
  w.st.events[6] = [{ event: 'closed', commit_id: null }, { event: 'reopened' }, { event: 'closed', commit_id: 'c7479a1d59e7' }];
  await run({ github: w.github, core: w.core, context: closedEvent(6, ['do not close']), env: { OD_SKIP_LABEL: 'do not close' } });
  assert.deepEqual(w.st.updates, ['6:open']);
  assert.match(w.st.comments[6][0].body, /closed by commit c7479a1\./);
});

test('riapertura: Status nel project e dry-run', async () => {
  const p = projectOctokit({ inProject: ['6'] });
  const w = world({ issues: { 'alanmasu/app#6': { state: 'closed', labels: ['do not close'] } } });
  w.st.closer[6] = { __typename: 'Commit', abbreviatedOid: 'abc1234' };
  await run({ github: w.github, core: w.core, context: closedEvent(6, ['do not close']), getOctokit: p.getOctokit,
    env: { ...projEnv({ OD_STATUS_ON_DEVELOP: '', OD_STATUS_ON_REVERT: '', OD_STATUS_ON_REOPEN: 'In progress' }), OD_SKIP_LABEL: 'do not close' } });
  assert.deepEqual(p.calls, ['token:pat', 'item-node-6 F1=o-prog']);
  const w2 = world({ issues: { 'alanmasu/app#6': { state: 'closed', labels: ['do not close'] } } });
  w2.st.closer[6] = { __typename: 'Commit', abbreviatedOid: 'abc1234' };
  await run({ github: w2.github, core: w2.core, context: closedEvent(6, ['do not close']), env: { OD_SKIP_LABEL: 'do not close', OD_DRY_RUN: 'true' } });
  assert.deepEqual(w2.st.updates, []);
  assert.deepEqual(w2.st.comments, {});
});
