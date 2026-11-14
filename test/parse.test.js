'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseClosingRefs, revertedSha, revertedPr } = require('../src/parse');

const cur = { owner: 'alanmasu', repo: 'app' };
const keys = (t) => parseClosingRefs(t, cur).map((r) => r.key);

test('tutte le 9 keyword, maiuscole e due punti', () => {
  for (const k of ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved']) {
    assert.deepEqual(keys(`${k} #1`), ['alanmasu/app#1'], k);
    assert.deepEqual(keys(`${k.toUpperCase()}: #2`), ['alanmasu/app#2'], k);
  }
  assert.deepEqual(keys('Closes:#3'), ['alanmasu/app#3']);
});

test('ogni riferimento vuole la sua keyword', () => {
  assert.deepEqual(keys('Fixes #1, #2'), ['alanmasu/app#1']);
  assert.deepEqual(keys('This closes #34, closes #23, and closes example_user/example_repo#42'),
    ['alanmasu/app#34', 'alanmasu/app#23', 'example_user/example_repo#42']);
});

test('altra repo, URL, stessa repo con nome esplicito', () => {
  assert.deepEqual(keys('Fixes my-org/lib.js#100'), ['my-org/lib.js#100']);
  assert.deepEqual(keys('resolves https://github.com/my-org/lib/issues/7'), ['my-org/lib#7']);
  assert.deepEqual(keys('fixes AlanMasu/App#5'), ['alanmasu/app#5']);
});

test('non sono riferimenti', () => {
  assert.deepEqual(keys('prefix #1'), []);          // "prefix" contiene "fix" ma non è la keyword
  assert.deepEqual(keys('fixes #12abc'), []);
  assert.deepEqual(keys('fixed the bug in #4'), []); // keyword non seguita dal riferimento
  assert.deepEqual(keys('fixes https://github.com/o/r/pull/3'), []);
});

const md = (t) => parseClosingRefs(t, cur, { markdown: true }).map((r) => r.key);

test('descrizioni PR: codice e commenti ignorati, duplicati rimossi', () => {
  assert.deepEqual(md('`fixes #1` <!-- closes #2 --> fixes #3 Fixes #3'), ['alanmasu/app#3']);
  assert.deepEqual(md('```\nfixes #9\n```\nresolves #10'), ['alanmasu/app#10']);
});

test('messaggi di commit: testo semplice, come GitHub', () => {
  assert.deepEqual(keys('This mentions `fixes #5` in code\n<!-- closes #6 -->'), ['alanmasu/app#5', 'alanmasu/app#6']);
});

test('revert', () => {
  assert.equal(revertedSha('Revert "Fix login, fixes #12"\n\nThis reverts commit 1a2b3c4d5e.'), '1a2b3c4d5e');
  assert.equal(revertedSha('Revert "x"\n\nThis reverts commit abcdef1, reversing\nchanges made to 1234567.'), 'abcdef1');
  assert.equal(revertedSha('fixes #1'), null);
  assert.deepEqual(revertedPr('Reverts alanmasu/app#45', cur), { owner: 'alanmasu', repo: 'app', number: 45 });
  assert.deepEqual(revertedPr('Reverts #45\n\nperché rompeva tutto', cur), { owner: 'alanmasu', repo: 'app', number: 45 });
});
