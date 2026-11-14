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
      if (q.includes('lastEditedAt')) {
        if (st.editCheckDown) throw new Error('graphql down');
        return { repository: { pullRequest: { lastEditedAt: (st.edited && st.edited[v.n]) || null, mergedAt: '2026-01-01T00:00:00Z' } } };
      }
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

const closedEvent = (number, labels) => ({
  eventName: 'issues', ref: '', repo: repoCtx,
  payload: { action: 'closed', repository: { default_branch: 'main' },
    issue: { number, node_id: `node-${number}`, labels: labels.map((name) => ({ name })) } },
});

// listCommits with real shas
function withShaCommits(w, prCommits) {
  w.github.paginate = async (fn, args) => {
    if (fn === 'listComments') return w.st.comments[args.issue_number] || [];
    if (fn === 'listEvents') return w.st.events[args.issue_number] || [];
    return (prCommits[args.pull_number] || []).map((c) => ({ sha: c.sha, commit: { message: c.message } }));
  };
}
module.exports = { test, assert, run, world, push, prEvent, open, closedEvent, withShaCommits };
