'use strict';

/**
 * Parses GitHub "closing keywords" with the same rules as GitHub:
 *
 *   KEYWORD #N                  -> issue in the same repository
 *   KEYWORD owner/repo#N        -> issue in another repository
 *   KEYWORD https://github.com/owner/repo/issues/N
 *
 * - keyword: close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved
 * - case-insensitive, a colon is allowed ("Closes: #10")
 * - every reference needs its OWN keyword: "Fixes #1, #2" closes only #1
 * - in pull request descriptions (markdown) code and HTML comments are ignored;
 *   in commit messages they are not: GitHub reads them as plain text (verified on GitHub)
 */

const KEYWORDS = 'close[sd]?|fix(?:e[sd])?|resolve[sd]?';
const NAME = '[A-Za-z0-9_.-]+';

const REF_RE = new RegExp(
  '(?<![A-Za-z0-9_])' +                       // the keyword must start a word
  `(?:${KEYWORDS})` +
  '(?:\\s*:\\s*|\\s+)' +                      // whitespace and/or colon
  '(?:' +
    `https?://github\\.com/(?<uOwner>${NAME})/(?<uRepo>${NAME})/issues/(?<uNum>\\d+)` +
    '|' +
    `(?:(?<owner>${NAME})/(?<repo>${NAME}))?#(?<num>\\d+)` +
  ')' +
  '(?![A-Za-z0-9_])',                         // "#12abc" is not a reference
  'gi'
);

const REVERT_RE = /This reverts commit ([0-9a-f]{7,40})/i;
const PR_REVERT_RE = new RegExp(`^Reverts (?:(${NAME})/(${NAME}))?#(\\d+)\\s*$`, 'i');

/**
 * Removes the parts of a markdown text that GitHub ignores: HTML comments, fenced code
 * (also indented, e.g. inside list items), indented code blocks and inline code.
 * When in doubt it removes more: a missed reference is safer than a wrong closure.
 */
function stripIgnored(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, ' ')                                   // HTML comments
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm, ' ') // fences, unclosed too
    .replace(/^(?: {4,}|\t).*$/gm, ' ')                                   // indented code
    .replace(/(`+)[^`]*?\1/g, ' ');                                      // inline code
}

// optional " (#32)": GitHub appends the pull request number when a revert PR is squash-merged
const REVERT_SUBJECT_RE = /^\s*(?:[*-]\s+)?Revert ".*"(?:\s*\(#\d+\))?\s*$/;
const REVERT_LINE_RE = /This reverts commit ([0-9a-f]{7,40})/i;

/**
 * Splits a commit message into ordered tokens: { revert: sha } for every
 * "This reverts commit <sha>" line, and { text } for everything else. The quoted subject of a
 * revert (Revert "Fix crash, fixes #5") is dropped: it repeats the keywords of the reverted
 * commit and must not count as a new fix.
 */
function messageTokens(message) {
  const tokens = [];
  let buf = [];
  const flush = () => { if (buf.length) { tokens.push({ text: buf.join('\n') }); buf = []; } };
  for (const line of String(message || '').split(/\r?\n/)) {
    const m = REVERT_LINE_RE.exec(line);
    if (m) { flush(); tokens.push({ revert: m[1] }); continue; }
    if (REVERT_SUBJECT_RE.test(line)) continue;
    buf.push(line);
  }
  flush();
  return tokens;
}

/**
 * Extracts the references to close.
 * @param {string} text
 * @param {{owner: string, repo: string}} current repository the action runs in
 * @param {{markdown?: boolean}} [options] true for pull request descriptions
 * @returns {{owner: string, repo: string, number: number, key: string}[]}
 */
function parseClosingRefs(text, current, { markdown = false } = {}) {
  const out = [];
  const seen = new Set();
  const source = markdown ? stripIgnored(text) : String(text || '');
  for (const m of source.matchAll(REF_RE)) {
    const g = m.groups;
    const owner = g.uOwner || g.owner || current.owner;
    const repo = g.uRepo || g.repo || current.repo;
    const number = Number(g.uNum || g.num);
    const key = refKey({ owner, repo, number });
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ owner, repo, number, key });
    }
  }
  return out;
}

/** If the message is a revert created by git, returns the SHA of the reverted commit. */
function revertedSha(message) {
  const m = REVERT_RE.exec(String(message || ''));
  return m ? m[1] : null;
}

/**
 * If the description is the one of GitHub's "Revert" button ("Reverts owner/repo#N" as its first
 * line), returns the reverted pull request. Comments and code are ignored.
 */
function revertedPr(body, current) {
  const first = stripIgnored(body).split('\n').map((l) => l.trim()).find((l) => l) || '';
  const m = PR_REVERT_RE.exec(first);
  if (!m) return null;
  return { owner: m[1] || current.owner, repo: m[2] || current.repo, number: Number(m[3]) };
}

function refKey({ owner, repo, number }) {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
}

module.exports = { parseClosingRefs, revertedSha, revertedPr, refKey, stripIgnored, messageTokens };
