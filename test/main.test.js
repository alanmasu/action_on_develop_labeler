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
        compareCommitsWithBasehead: async ({ basehead }) => ({
          data: { commits: ((st.compareBy && st.compareBy[basehead]) || compare).map((c) => ({
            sha: c.sha, commit: { message: c.message }, parents: Array.from({ length: c.parents || 1 }, () => ({})) })) },
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

test('rilascio: chiude le issue fixate solo da descrizioni di PR e toglie "on develop"', async () => {
  const w = world({
    issues: {
      'alanmasu/app#1': open(['on develop']),                        // Fixes in a commit: GitHub closes it
      'alanmasu/app#2': open(['on develop']),                        // only in the PR description
      'alanmasu/app#3': { state: 'closed', labels: ['on develop'] }, // already closed
      'alanmasu/app#4': open(['do not close']),
    },
    prs: { 20: { number: 20, merge_commit_sha: 'm'.repeat(40), body: 'Closes #2\n\n<!-- Fixes #9 -->' } },
    compare: [
      { sha: 'a'.repeat(40), message: 'fix: one\n\nFixes #1, fixes #3, fixes #4' },
      { sha: 'm'.repeat(40), message: 'Merge pull request #20 from alanmasu/fix/2', parents: 2 },
    ],
  });
  const ctx = push('main', { after: 'f'.repeat(40) });
  await run({ github: w.github, core: w.core, context: ctx, env: { OD_SKIP_LABEL: 'do not close' } });
  assert.deepEqual(w.st.released, ['alanmasu/app#2']);
  assert.equal(w.st.issues['alanmasu/app#2'].state, 'closed');
  assert.match(w.st.comments[2][0].body, /fixed by pull request #20 and released to `main` in fffffff/);
  assert.equal(w.st.issues['alanmasu/app#1'].state, 'open'); // left to GitHub
  for (const n of [1, 2, 3]) assert.deepEqual(w.st.issues[`alanmasu/app#${n}`].labels, [], `#${n}`);
  assert.deepEqual(w.st.issues['alanmasu/app#4'].labels, ['do not close']);
  assert.equal(w.st.issues['alanmasu/app#4'].state, 'open');
});

test('rilascio: release-cleanup disattivato non tocca nulla', async () => {
  const w = world({ issues: { 'alanmasu/app#1': open(['on develop']) }, compare: [{ sha: 'a'.repeat(40), message: 'fixes #1' }] });
  await run({ github: w.github, core: w.core, context: push('main'), env: { OD_RELEASE_CLEANUP: 'false' } });
  assert.deepEqual(w.st.issues['alanmasu/app#1'].labels, ['on develop']);
});

test('fix annullato: issue chiusa dal commit al rilascio viene riaperta', async () => {
  const w = world({
    issues: { 'alanmasu/app#25': { state: 'closed', labels: [] } },
    commits: { abcdef1: { message: 'fix: x\n\nFixes #25' } },
  });
  w.st.closer[25] = { __typename: 'Commit', abbreviatedOid: 'abcdef1', oid: 'abcdef1' };
  w.st.compareBy = { 'abcdef1...main': [
    { sha: 'b'.repeat(40), message: 'chore: unrelated' },
    { sha: 'r'.repeat(40), message: 'Revert "fix: x"\n\nThis reverts commit abcdef1.' },
  ] };
  const p = projectOctokit({ inProject: ['25'] });
  await run({ github: w.github, core: w.core, context: closedEvent(25, []), getOctokit: p.getOctokit,
    env: { ...projEnv({ OD_STATUS_ON_DEVELOP: '', OD_STATUS_ON_REVERT: 'In progress' }) } });
  assert.deepEqual(w.st.updates, ['25:open']);
  assert.match(w.st.comments[25][0].body, /closed by commit abcdef1, but that fix was reverted by commit rrrrrrr/);
  assert.deepEqual(p.calls, ['token:pat', 'item-node-25 F1=o-prog']);
});

test('fix non annullato, chiusa da PR o a mano, opzione spenta: resta chiusa', async () => {
  const w = world({ issues: { 'alanmasu/app#25': { state: 'closed', labels: [] } }, commits: { abcdef1: { message: 'fix: x\n\nFixes #25' } } });
  w.st.closer[25] = { __typename: 'Commit', abbreviatedOid: 'abcdef1', oid: 'abcdef1' };
  w.st.compareBy = { 'abcdef1...main': [{ sha: 'b'.repeat(40), message: 'chore: unrelated' }] };
  await run({ github: w.github, core: w.core, context: closedEvent(25, []), env: {} });
  w.st.closer[25] = { __typename: 'PullRequest', number: 12 };
  await run({ github: w.github, core: w.core, context: closedEvent(25, []), env: {} });
  w.st.closer[25] = null;
  await run({ github: w.github, core: w.core, context: closedEvent(25, []), env: {} });
  w.st.closer[25] = { __typename: 'Commit', abbreviatedOid: 'abcdef1', oid: 'abcdef1' };
  w.st.compareBy = { 'abcdef1...main': [{ sha: 'r'.repeat(40), message: 'Revert "x"\n\nThis reverts commit abcdef1.' }] };
  await run({ github: w.github, core: w.core, context: closedEvent(25, []), env: { OD_REOPEN_REVERTED: 'false' } });
  assert.deepEqual(w.st.updates, []);
  assert.ok(w.logs.some((l) => l.includes('which was not reverted')));
  assert.ok(w.logs.some((l) => l.includes('was not closed by a commit')));
});

// ---------------------------------------------------------------- review findings

test('review 1: rilascio non chiude issue senza "on develop" anche se la descrizione della PR le cita', async () => {
  const w = world({
    issues: { 'alanmasu/app#1': open([]), 'alanmasu/app#2': open(['on develop']) },
    prs: { 20: { number: 20, merge_commit_sha: 'm'.repeat(40), body: 'Fixes #1\nFixes #2' } },
    compare: [{ sha: 'm'.repeat(40), message: 'Merge pull request #20 from x/y', parents: 2 }],
  });
  await run({ github: w.github, core: w.core, context: push('main', { after: 'f'.repeat(40) }), env: {} });
  assert.equal(w.st.issues['alanmasu/app#1'].state, 'open');
  assert.equal(w.st.issues['alanmasu/app#2'].state, 'closed');
});

test('review 2: revert di una PR che conteneva fix e revert non resuscita il fix', async () => {
  const w = world({
    issues: { 'alanmasu/app#5': open([]) },
    commits: { abcdef1: { message: 'Fix crash, fixes #5' } },
    prs: {
      10: { number: 10, body: 'stuff', commits: ['Fix crash, fixes #5', 'Revert "Fix crash, fixes #5"\n\nThis reverts commit abcdef1.'] },
    },
  });
  await run({ github: w.github, core: w.core, context: prEvent({ number: 11, body: 'Reverts alanmasu/app#10' }), env: {} });
  assert.deepEqual(w.st.issues['alanmasu/app#5'].labels, []);
  assert.deepEqual(w.st.labeled, []);
});

test('review 3: issue chiusa dal commit di revert stesso viene riaperta', async () => {
  const w = world({
    issues: { 'alanmasu/app#5': { state: 'closed', labels: [] } },
    commits: {
      abcdef1: { message: 'Fix crash, fixes #5' },
      fedcba9: { message: 'Revert "Fix crash, fixes #5"\n\nThis reverts commit abcdef1.' },
    },
  });
  w.st.closer[5] = { __typename: 'Commit', abbreviatedOid: 'fedcba9', oid: 'fedcba9' };
  w.st.compareBy = { 'fedcba9...main': [] };
  await run({ github: w.github, core: w.core, context: closedEvent(5, []), env: {} });
  assert.deepEqual(w.st.updates, ['5:open']);
  assert.match(w.st.comments[5][0].body, /reverted by commit fedcba9/);
});

test('review 4: codice indentato e fence nelle liste sono ignorati nelle descrizioni', async () => {
  const w = world({ issues: { 'alanmasu/app#5': open(), 'alanmasu/app#6': open(), 'alanmasu/app#7': open() } });
  await run({ github: w.github, core: w.core, env: {},
    context: prEvent({ number: 31, body: 'Text\n\n    Fixes #5\n\n- item\n  ```\n  Fixes #6\n  ```\n\nCloses #7' }) });
  assert.deepEqual(w.st.labeled, ['alanmasu/app#7']);
});

test('review 5: messaggio squash con revert e nuovi fix', async () => {
  const w = world({
    issues: { 'alanmasu/app#5': open(['on develop']), 'alanmasu/app#7': open(), 'alanmasu/app#8': open(['on develop']) },
    commits: { abc1234: { message: 'fix: old, fixes #8' }, abcdef1: { message: 'fix: crash, fixes #5' } },
    compare: [{ sha: 's'.repeat(40), message: 'feat: squash (#40)\n\n* Revert "fix: old, fixes #8"\n\nThis reverts commit abc1234.\n\n* closes #7\n\n* Revert "fix: crash, fixes #5"\n\nThis reverts commit abcdef1.\n\n* fix crash again, fixes #5' }],
  });
  await run({ github: w.github, core: w.core, context: push('develop'), env: {} });
  assert.deepEqual(w.st.issues['alanmasu/app#7'].labels, ['on develop']); // new fix in the squash
  assert.deepEqual(w.st.issues['alanmasu/app#8'].labels, []);              // reverted
  assert.deepEqual(w.st.issues['alanmasu/app#5'].labels, ['on develop']); // reverted, then fixed again
});

test('review 6: push forzato sul branch di default salta la pulizia', async () => {
  const w = world({
    issues: { 'alanmasu/app#2': open(['on develop']) },
    prs: { 20: { number: 20, merge_commit_sha: 'm'.repeat(40), body: 'Closes #2' } },
    compare: [{ sha: 'm'.repeat(40), message: 'Merge pull request #20 from x/y', parents: 2 }],
  });
  await run({ github: w.github, core: w.core, context: push('main', { forced: true }), env: {} });
  assert.equal(w.st.issues['alanmasu/app#2'].state, 'open');
  assert.ok(w.logs.some((l) => l.startsWith('WARN Forced push')));
});

test('review 7: errore nel controllo del revert non fa fallire il run', async () => {
  const w = world({ issues: { 'alanmasu/app#5': { state: 'closed', labels: [] } } }); // closer commit unknown -> 404
  w.st.closer[5] = { __typename: 'Commit', abbreviatedOid: '1234567', oid: '1234567' };
  await run({ github: w.github, core: w.core, context: closedEvent(5, []), env: {} });
  assert.deepEqual(w.st.updates, []);
  assert.ok(w.logs.some((l) => l.includes('cannot check whether its fix was reverted')));
});

test('review 8: "Reverts other/repo#N" legge i dati della PR giusta', async () => {
  const w = world({ issues: { 'other/lib#3': open(['on develop']) } });
  const seen = [];
  w.github.rest.pulls.get = async ({ owner, repo, pull_number }) => {
    seen.push(`get ${owner}/${repo}#${pull_number}`);
    return { data: { number: pull_number, body: 'Closes #3', base: { repo: { owner: { login: owner }, name: repo } } } };
  };
  const origGraphql = w.github.graphql;
  w.github.graphql = async (q, v) => { if (q.includes('closingIssuesReferences')) seen.push(`links ${v.owner}/${v.repo}#${v.n}`); return origGraphql(q, v); };
  await run({ github: w.github, core: w.core, context: prEvent({ number: 50, body: 'Reverts other/lib#9' }), env: {} });
  assert.ok(seen.includes('get other/lib#9') && seen.includes('links other/lib#9'), seen.join(', '));
  assert.deepEqual(w.st.unlabeled, ['other/lib#3']); // "#3" is resolved in other/lib, not alanmasu/app
});

// ------------------------------------------------------- round 2 review findings

test('round 2/1: revert di un revert mergiato con squash ("... (#32)")', async () => {
  const A = 'a'.repeat(40);
  const S = 'c'.repeat(40);
  const w = world({
    issues: { 'alanmasu/app#5': open() },
    commits: { [A]: { message: 'Fix crash, fixes #5' }, [S]: { message: `Revert "Fix crash, fixes #5" (#32)\n\nThis reverts commit ${A}.` } },
    compare: [{ sha: 'd'.repeat(40), message: `Revert "Revert "Fix crash, fixes #5" (#32)"\n\nThis reverts commit ${S}.` }],
  });
  await run({ github: w.github, core: w.core, context: push('develop'), env: {} });
  assert.deepEqual(w.st.issues['alanmasu/app#5'].labels, ['on develop']);
});

test('round 2/2: "Reverts #N" in un commento o non in prima riga non è un revert', async () => {
  const w = world({
    issues: { 'alanmasu/app#7': open(), 'alanmasu/app#8': open(['on develop']) },
    prs: { 30: { number: 30, body: 'Closes #8' } },
  });
  await run({ github: w.github, core: w.core, context: prEvent({ number: 31, body: 'Closes #7\n\n<!--\nReverts #30\n-->' }), env: {} });
  await run({ github: w.github, core: w.core, context: prEvent({ number: 32, body: 'Some text\n\nReverts #30' }), env: {} });
  assert.deepEqual(w.st.issues['alanmasu/app#7'].labels, ['on develop']);
  assert.deepEqual(w.st.issues['alanmasu/app#8'].labels, ['on develop']);
});

test('round 2/3: una PR di revert conserva le proprie keyword', async () => {
  const w = world({
    issues: { 'alanmasu/app#7': open(), 'alanmasu/app#8': open(['on develop']) },
    prs: { 30: { number: 30, body: 'Closes #8' } },
  });
  await run({ github: w.github, core: w.core, context: prEvent({ number: 31, body: 'Reverts alanmasu/app#30\n\nFixes #7' }), env: {} });
  assert.deepEqual(w.st.issues['alanmasu/app#7'].labels, ['on develop']);
  assert.deepEqual(w.st.issues['alanmasu/app#8'].labels, []);
});

test('round 2/4: push e PR della stessa merge arrivano allo stesso risultato in qualsiasi ordine', async () => {
  const A = 'a'.repeat(40);
  const M = 'm'.repeat(40);
  const pr = { number: 40, merge_commit_sha: M, body: 'New approach. Closes #5' };
  const mk = () => world({
    issues: { 'alanmasu/app#5': open(['on develop']) },
    commits: { [A]: { message: 'Fix crash, fixes #5' } },
    prs: { 40: pr },
    compare: [
      { sha: 'r'.repeat(40), message: `Revert "Fix crash, fixes #5"\n\nThis reverts commit ${A}.` },
      { sha: M, message: 'Merge pull request #40 from x/y', parents: 2 },
    ],
  });
  const w1 = mk();
  await run({ github: w1.github, core: w1.core, context: push('develop'), env: {} });
  await run({ github: w1.github, core: w1.core, context: prEvent(pr), env: {} });
  const w2 = mk();
  await run({ github: w2.github, core: w2.core, context: prEvent(pr), env: {} });
  await run({ github: w2.github, core: w2.core, context: push('develop'), env: {} });
  assert.deepEqual(w1.st.issues['alanmasu/app#5'].labels, ['on develop']);
  assert.deepEqual(w2.st.issues['alanmasu/app#5'].labels, ['on develop']);
});

test('round 2/5: riapertura che fallisce non fa fallire il run', async () => {
  const w = world({ issues: { 'alanmasu/app#6': { state: 'closed', labels: ['do not close'] } } });
  w.st.closer[6] = { __typename: 'Commit', abbreviatedOid: 'abc1234', oid: 'abc1234' };
  w.github.rest.issues.update = async () => { throw err(403); };
  await run({ github: w.github, core: w.core, context: closedEvent(6, ['do not close']), env: { OD_SKIP_LABEL: 'do not close' } });
  assert.ok(w.logs.some((l) => l.includes('could not reopen it')));
});

test('round 2 e2e: avviso corretto quando la issue "do not close" è citata in una descrizione di PR', async () => {
  const w = world({ issues: { 'alanmasu/app#42': open(['do not close']) } });
  await run({ github: w.github, core: w.core, context: prEvent({ number: 51, body: 'Closes #42' }), env: { OD_SKIP_LABEL: 'do not close' } });
  assert.match(w.st.comments[42][0].body, /PR #51 merged into `develop`.*\nIt will stay open/);
  assert.doesNotMatch(w.st.comments[42][0].body, /GitHub will close/);
});

// ------------------------------------------------------- round 3 review findings

// Reviewer's scenario A, with the correct expectation: PR #20 only reverts PR #19, so reverting
// PR #20 restores PR #19, which fixes #5. Reverting a unit restores the state before it.
test('round 3/A: revert della PR che annullava la #19 rimette il fix della #19', async () => {
  const M19 = '1919191';
  const M20 = '2020202';
  const R1 = `Revert "Merge pull request #19 from x/a"\n\nThis reverts commit ${M19}, reversing\nchanges made to 0000001.`;
  const R2 = `Revert "Merge pull request #20 from x/b"\n\nThis reverts commit ${M20}, reversing\nchanges made to 0000002.`;
  const base = () => ({
    commits: { [M19]: { message: 'Merge pull request #19 from x/a', parents: [{}, {}] },
               [M20]: { message: 'Merge pull request #20 from x/b', parents: [{}, {}] } },
    prs: { 19: { number: 19, merge_commit_sha: M19, body: 'Closes #5', commits: ['first attempt'] },
           20: { number: 20, merge_commit_sha: M20, body: 'Closes #5', commits: [R1] } },
  });
  let w = world({ issues: { 'alanmasu/app#5': open([]) }, ...base(),
    compare: [{ sha: 'e1e1e1e', message: R1 }, { sha: M20, message: 'Merge pull request #20 from x/b', parents: 2 }] });
  await run({ github: w.github, core: w.core, context: push('develop'), env: {} });
  assert.deepEqual(w.st.issues['alanmasu/app#5'].labels, ['on develop']);
  w = world({ issues: w.st.issues, ...base(), compare: [{ sha: 'e2e2e2e', message: R2 }] });
  await run({ github: w.github, core: w.core, context: push('develop'), env: {} });
  assert.deepEqual(w.st.issues['alanmasu/app#5'].labels, ['on develop']); // PR #19 is back
  w = world({ issues: w.st.issues, ...base(), compare: [
    { sha: M19, message: 'Merge pull request #19 from x/a', parents: 2 }, { sha: 'e1e1e1e', message: R1 },
    { sha: M20, message: 'Merge pull request #20 from x/b', parents: 2 }, { sha: 'e2e2e2e', message: R2 }] });
  await run({ github: w.github, core: w.core, context: push('main', { after: 'f'.repeat(40) }), env: {} });
  assert.equal(w.st.issues['alanmasu/app#5'].state, 'closed'); // the fix of PR #19 is released
});

test('round 3/A bis: annullare una PR che conteneva un fix (commit prima della descrizione) toglie la label', async () => {
  const M = '3030303';
  const w = world({
    issues: { 'alanmasu/app#5': open(['on develop']) },
    commits: { [M]: { message: 'Merge pull request #30 from x/c', parents: [{}, {}] } },
    prs: { 30: { number: 30, merge_commit_sha: M, body: 'Closes #5', commits: ['wip'] } },
    compare: [{ sha: 'e4e4e4e', message: `Revert "Merge pull request #30 from x/c"\n\nThis reverts commit ${M}, reversing\nchanges made to 0000003.` }],
  });
  await run({ github: w.github, core: w.core, context: push('develop'), env: {} });
  assert.deepEqual(w.st.issues['alanmasu/app#5'].labels, []);
});

test('round 3/B: fix annullato e poi rifatto dalla descrizione di una PR: resta chiusa', async () => {
  const w = world({
    issues: { 'alanmasu/app#5': { state: 'closed', labels: [] } },
    commits: { abcdef1: { message: 'Fixes #5' } },
    prs: { 30: { number: 30, merge_commit_sha: 'c3c3c3c', body: 'Closes #5' } },
  });
  w.st.closer[5] = { __typename: 'Commit', abbreviatedOid: 'abcdef1', oid: 'abcdef1' };
  w.st.compareBy = { 'abcdef1...main': [
    { sha: 'dddddd1', message: 'Revert "Fixes #5"\n\nThis reverts commit abcdef1.' },
    { sha: 'c3c3c3c', message: 'Merge pull request #30 from x/c', parents: 2 },
  ] };
  await run({ github: w.github, core: w.core, context: closedEvent(5, []), env: {} });
  assert.deepEqual(w.st.updates, []);
});

test('round 3/C: un revert di un fix diverso e più vecchio non riapre', async () => {
  const w = world({
    issues: { 'alanmasu/app#5': { state: 'closed', labels: [] } },
    commits: { abcdef1: { message: 'New fix, fixes #5' }, '0ddf00d': { message: 'Old fix, fixes #5' } },
  });
  w.st.closer[5] = { __typename: 'Commit', abbreviatedOid: 'abcdef1', oid: 'abcdef1' };
  w.st.compareBy = { 'abcdef1...main': [
    { sha: 'h0h0h0h', message: 'Revert "Old fix, fixes #5"\n\nThis reverts commit 0ddf00d.' },
    { sha: 'm0m0m0m', message: "Merge branch 'develop'", parents: 2 },
  ] };
  await run({ github: w.github, core: w.core, context: closedEvent(5, []), env: {} });
  assert.deepEqual(w.st.updates, []);
});

test('round 3/C bis: revert di un merge che contiene il commit di chiusura riapre', async () => {
  const w = world({
    issues: { 'alanmasu/app#5': { state: 'closed', labels: [] } },
    commits: { abcdef1: { message: 'fix, fixes #5' }, '7777777': { message: 'Merge pull request #7 from x/y', parents: [{}, {}] } },
    prs: { 7: { number: 7, merge_commit_sha: '7777777', body: 'stuff', commits: [{ sha: 'abcdef1', message: 'fix, fixes #5' }] } },
  });
  w.github.paginate = async (fn, args) => (fn === 'listCommits'
    ? w.github._prs[args.pull_number].commits.map((c) => ({ sha: c.sha, commit: { message: c.message } }))
    : []);
  w.github._prs = { 7: { commits: [{ sha: 'abcdef1', message: 'fix, fixes #5' }] } };
  w.st.closer[5] = { __typename: 'Commit', abbreviatedOid: 'abcdef1', oid: 'abcdef1' };
  w.st.compareBy = { 'abcdef1...main': [
    { sha: '7777777', message: 'Merge pull request #7 from x/y', parents: 2 },
    { sha: 'r7r7r7r', message: 'Revert "Merge pull request #7 from x/y"\n\nThis reverts commit 7777777, reversing\nchanges made to 0000001.' },
  ] };
  await run({ github: w.github, core: w.core, context: closedEvent(5, []), env: {} });
  assert.deepEqual(w.st.updates, ['5:open']);
});

test('round 3/D: git revert di una PR mergiata con squash toglie la label', async () => {
  const w = world({
    issues: { 'alanmasu/app#5': open(['on develop']) },
    commits: { '5a5a5a5': { message: 'Feature X (#40)\n\n* wip\n* tests' } },
    prs: { 40: { number: 40, merge_commit_sha: '5a5a5a5', body: 'Closes #5' } },
    compare: [{ sha: 'e3e3e3e', message: 'Revert "Feature X (#40)"\n\nThis reverts commit 5a5a5a5.' }],
  });
  await run({ github: w.github, core: w.core, context: push('develop'), env: {} });
  assert.deepEqual(w.st.issues['alanmasu/app#5'].labels, []);
});

// ------------------------------------------------------- round 3 end-to-end findings

test('round 3 e2e/E1: fix solo da descrizione, revert squash e reapply: chiusa al rilascio', async () => {
  const M66 = '6666666';
  const S69 = '6969696';
  const RA = '7070707';
  const msgS69 = `Revert "Merge pull request #66 from x/a" (#69)\n\nThis reverts commit ${M66}, reversing\nchanges made to 0000001.`;
  const msgRA = `Reapply "Revert "Merge pull request #66 from x/a" (#69)"\n\nThis reverts commit ${S69}.`;
  const w = world({
    issues: { 'alanmasu/app#56': open(['on develop']) },
    commits: { [M66]: { message: 'Merge pull request #66 from x/a', parents: [{}, {}] }, [S69]: { message: msgS69 } },
    prs: { 66: { number: 66, merge_commit_sha: M66, body: 'Fixes #56', commits: ['work'] },
           69: { number: 69, merge_commit_sha: S69, body: 'Reverts alanmasu/app#66' } },
    compare: [
      { sha: M66, message: 'Merge pull request #66 from x/a', parents: 2 },
      { sha: S69, message: msgS69 },
      { sha: RA, message: msgRA },
    ],
  });
  await run({ github: w.github, core: w.core, context: push('main', { after: 'f'.repeat(40) }), env: {} });
  assert.equal(w.st.issues['alanmasu/app#56'].state, 'closed');
  assert.deepEqual(w.st.released, ['alanmasu/app#56']);
});

test('round 3 e2e/E1 bis: al rilascio non chiude ciò che chiude GitHub (keyword in un commit)', async () => {
  const w = world({
    issues: { 'alanmasu/app#64': open(['on develop']) },
    compare: [{ sha: 'a'.repeat(40), message: 'fix: x\n\nFixes #64' }],
  });
  await run({ github: w.github, core: w.core, context: push('main', { after: 'f'.repeat(40) }), env: {} });
  assert.equal(w.st.issues['alanmasu/app#64'].state, 'open'); // GitHub closes it
  assert.deepEqual(w.st.issues['alanmasu/app#64'].labels, []);
});

test('round 3 e2e/E3: "Reverts #N" verso una PR inesistente conserva le proprie keyword', async () => {
  const w = world({ issues: { 'alanmasu/app#75': open() } });
  await run({ github: w.github, core: w.core, context: prEvent({ number: 77, body: 'Reverts alanmasu/app#9999\n\nFixes #75' }), env: {} });
  assert.deepEqual(w.st.issues['alanmasu/app#75'].labels, ['on develop']);
});

test('round 3 e2e: avviso "do not close" da descrizione scritto una sola volta da push + PR in parallelo', async () => {
  const M = '7373737';
  const pr = { number: 73, merge_commit_sha: M, body: 'Closes #63' };
  const w = world({
    issues: { 'alanmasu/app#63': open(['do not close']) },
    prs: { 73: pr },
    compare: [{ sha: M, message: 'Merge pull request #73 from x/y', parents: 2 }],
  });
  const env = { OD_SKIP_LABEL: 'do not close' };
  await Promise.all([
    run({ github: w.github, core: w.core, context: push('develop'), env }),
    run({ github: w.github, core: w.core, context: prEvent(pr), env }),
  ]);
  assert.equal(w.st.comments[63].length, 1);
});
