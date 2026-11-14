const { test, assert, run, world, push, prEvent, open, closedEvent, withShaCommits } = require('./harness');

// F1: PR #10 merged with merge commit M; its commit A "fixes #5", description "Fixes #5".
// The whole PR is reverted (GitHub revert button / git revert -m1 M). Release closes #5 via A.
test('round 5/F1: revert of a merge whose description also fixes: should reopen', { todo: 'awaiting decision' }, async () => {
  const A = 'a1'.repeat(20);
  const M = 'b2'.repeat(20);
  const mmsg = 'Merge pull request #10 from x/crash\n\nFix crash';
  const w = world({
    issues: { 'alanmasu/app#5': { state: 'closed', labels: [] } },
    commits: { [A]: { message: 'Fix crash, fixes #5' }, [M]: { message: mmsg, parents: [{}, {}] } },
    prs: { 10: { number: 10, merge_commit_sha: M, body: 'Fixes #5' } },
  });
  withShaCommits(w, { 10: [{ sha: A, message: 'Fix crash, fixes #5' }] });
  w.st.closer[5] = { __typename: 'Commit', abbreviatedOid: A.slice(0, 7), oid: A };
  w.st.compareBy = { [`${A}...main`]: [
    { sha: M, message: mmsg, parents: 2 },
    { sha: 'r'.repeat(40), message: `Revert "Merge pull request #10 from x/crash"\n\nThis reverts commit ${M}, reversing\nchanges made to 0000001.` },
    { sha: 'z'.repeat(40), message: "Merge branch 'develop'", parents: 2 },
  ] };
  await run({ github: w.github, core: w.core, context: closedEvent(5, []), env: {} });
  console.log(w.logs.join('\n'));
  assert.deepEqual(w.st.updates, ['5:open']);
});

// control: same without description -> reopens
test('round 5/F1 control: same, description without keyword: reopens', async () => {
  const A = 'a1'.repeat(20);
  const M = 'b2'.repeat(20);
  const mmsg = 'Merge pull request #10 from x/crash\n\nFix crash';
  const w = world({
    issues: { 'alanmasu/app#5': { state: 'closed', labels: [] } },
    commits: { [A]: { message: 'Fix crash, fixes #5' }, [M]: { message: mmsg, parents: [{}, {}] } },
    prs: { 10: { number: 10, merge_commit_sha: M, body: 'stuff' } },
  });
  withShaCommits(w, { 10: [{ sha: A, message: 'Fix crash, fixes #5' }] });
  w.st.closer[5] = { __typename: 'Commit', abbreviatedOid: A.slice(0, 7), oid: A };
  w.st.compareBy = { [`${A}...main`]: [
    { sha: M, message: mmsg, parents: 2 },
    { sha: 'r'.repeat(40), message: `Revert "Merge pull request #10 from x/crash"\n\nThis reverts commit ${M}, reversing\nchanges made to 0000001.` },
  ] };
  await run({ github: w.github, core: w.core, context: closedEvent(5, []), env: {} });
  assert.deepEqual(w.st.updates, ['5:open']);
});

// F2: fork PR #20 merged into develop; author edits the body after the merge so it starts with
// "Reverts <nonexistent>" and adds "Fixes #99". Push run on develop sees the edited body (race),
// labels #99; at release verifyBody is bypassed by the revert branch.
test('round 5/F2: edited body behind "Reverts" bypasses verification at release', async () => {
  const M = 'm'.repeat(40);
  const body = 'Reverts alanmasu/app#9999\n\nFixes #99';
  const w = world({
    issues: { 'alanmasu/app#99': open(['on develop']) },
    prs: { 20: { number: 20, merge_commit_sha: M, merged_at: '2026-01-01T00:00:00Z', body } },
    compare: [{ sha: M, message: 'Merge pull request #20 from fork/typo', parents: 2 }],
  });
  w.st.edited = { 20: '2026-02-01T00:00:00Z' };
  await run({ github: w.github, core: w.core, context: push('main', { after: 'f'.repeat(40) }), env: {} });
  console.log(w.logs.join('\n'));
  assert.equal(w.st.issues['alanmasu/app#99'].state, 'open', 'edited description must not close');
});
