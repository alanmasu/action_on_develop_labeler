const { test, assert, run, world, push, prEvent, open, closedEvent, withShaCommits } = require('./harness');
const h = (c) => c.repeat(40).slice(0, 40);

// F3: PR #10 (merge M) contains A1 and A2, both "fixes #5". Revert R of M, reapply RR of R,
// then revert X of A2 only. A1 is still applied -> must stay closed.
test('round 5/F3: reapply of a merge revert restores only one of its fixes', async () => {
  const A1 = h('a1'), A2 = h('a2'), M = h('b2'), R = h('c3'), RR = h('d4'), X = h('e5');
  const mmsg = 'Merge pull request #10 from x/crash';
  const w = world({
    issues: { 'alanmasu/app#5': { state: 'closed', labels: [] } },
    commits: { [A1]: { message: 'part 1, fixes #5' }, [M]: { message: mmsg, parents: [{}, {}] } },
    prs: { 10: { number: 10, merge_commit_sha: M, body: 'stuff' } },
  });
  withShaCommits(w, { 10: [{ sha: A1, message: 'part 1, fixes #5' }, { sha: A2, message: 'part 2, fixes #5' }] });
  w.st.closer[5] = { __typename: 'Commit', abbreviatedOid: A1.slice(0, 7), oid: A1 };
  w.st.compareBy = { [`${A1}...main`]: [
    { sha: A2, message: 'part 2, fixes #5' },
    { sha: M, message: mmsg, parents: 2 },
    { sha: R, message: `Revert "${mmsg}"\n\nThis reverts commit ${M}, reversing\nchanges made to 0000001.` },
    { sha: RR, message: `Reapply "${mmsg}"\n\nThis reverts commit ${R}.` },
    { sha: X, message: `Revert "part 2, fixes #5"\n\nThis reverts commit ${A2}.` },
  ] };
  await run({ github: w.github, core: w.core, context: closedEvent(5, []), env: {} });
  assert.deepEqual(w.st.updates, [], 'A1 is still applied');
});

// F4: nested PR description (reapply of a revert of a fork PR merge) is not verified at release
test('round 5/F4: edited body reached through Reapply is not verified at release', async () => {
  const M = h('b2'), R = h('c3'), RR = h('d4');
  const mmsg = 'Merge pull request #20 from fork/typo';
  const w = world({
    issues: { 'alanmasu/app#99': open(['on develop']) },
    commits: { [M]: { message: mmsg, parents: [{}, {}] }, [R]: { message: `Revert "${mmsg}"\n\nThis reverts commit ${M}, reversing\nchanges made to 0000001.` } },
    prs: { 20: { number: 20, merge_commit_sha: M, merged_at: '2026-01-01T00:00:00Z', body: 'Typo\n\nFixes #99', commits: ['typo'] } },
    compare: [
      { sha: M, message: mmsg, parents: 2 },
      { sha: R, message: `Revert "${mmsg}"\n\nThis reverts commit ${M}, reversing\nchanges made to 0000001.` },
      { sha: RR, message: `Reapply "${mmsg}"\n\nThis reverts commit ${R}.` },
    ],
  });
  w.st.edited = { 20: '2026-02-01T00:00:00Z' };
  await run({ github: w.github, core: w.core, context: push('main', { after: 'f'.repeat(40) }), env: {} });
  assert.equal(w.st.issues['alanmasu/app#99'].state, 'open', 'edited description must not close');
});
