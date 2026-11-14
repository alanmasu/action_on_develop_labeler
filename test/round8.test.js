const { test, assert, run, world, push, prEvent, open } = require('./harness');
const MA = 'm1'.repeat(20), MB = 'm2'.repeat(20), MR = 'm3'.repeat(20);
const rel = (commits) => push('main', {});
function relWorld(prs, issues) {
  const commits = {};
  const w = world({ issues, prs, commits,
    compare: Object.values(prs).map((p) => ({ sha: p.merge_commit_sha, message: `Merge pull request #${p.number} from x/y`, parents: 2 })) });
  return w;
}
// F1: trusted fix by A, later an untrusted (edited) add for the same issue by B
test('round 8: release: untrusted add of B overrides trusted add of A -> #5 should still be closed', async () => {
  const w = relWorld({
    1: { number: 1, merge_commit_sha: MA, body: 'Fixes #5' },
    2: { number: 2, merge_commit_sha: MB, body: 'Also fixes #5 (typo fixed)' },
  }, { 'alanmasu/app#5': open(['on develop']) });
  w.st.edited = { 2: '2026-02-01T00:00:00Z' };
  await run({ github: w.github, core: w.core, context: push('main'), env: {} });
  console.log(w.logs.join('\n'));
  console.log('issue', w.st.issues['alanmasu/app#5']);
  assert.equal(w.st.issues['alanmasu/app#5'].state, 'closed');
});
// F1b: trusted fix by A, later PR R edited after merge to "Reverts #1": #5 left open AND labeled
test('round 8: release: untrusted Reverts line -> label left on released issue', async () => {
  const w = relWorld({
    1: { number: 1, merge_commit_sha: MA, body: 'Fixes #5' },
    3: { number: 3, merge_commit_sha: MR, body: 'Reverts alanmasu/app#1' },
  }, { 'alanmasu/app#5': open(['on develop']) });
  w.st.edited = { 3: '2026-02-01T00:00:00Z' };
  await run({ github: w.github, core: w.core, context: push('main'), env: {} });
  console.log(w.logs.join('\n'));
  console.log('issue', w.st.issues['alanmasu/app#5']);
  assert.ok(!w.st.issues['alanmasu/app#5'].labels.includes('on develop'), 'label left after release');
});
// control: re-apply of reverted merge with edited body never labels Z (develop)
test('round 8: develop: revert of revert of merge with edited body adding #7 -> no label', async () => {
  const R1 = 'r1'.repeat(20), R2 = 'r2'.repeat(20);
  const w = world({
    issues: { 'alanmasu/app#7': open([]) },
    commits: { [MA]: { message: 'Merge pull request #1 from x/y', parents: [{}, {}] },
      [R1]: { message: `Revert "Merge pull request #1"\n\nThis reverts commit ${MA}, reversing\nchanges made to 00.` } },
    prs: { 1: { number: 1, merge_commit_sha: MA, body: 'Fixes #7' } },
    compare: [{ sha: R2, message: `Revert "Revert ..."\n\nThis reverts commit ${R1}.` }],
  });
  w.st.edited = { 1: '2026-02-01T00:00:00Z' };
  await run({ github: w.github, core: w.core, context: push('develop'), env: {} });
  assert.deepEqual(w.st.issues['alanmasu/app#7'].labels, []);
});
