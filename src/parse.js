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
const PR_REVERT_RE = new RegExp(`^Reverts (?:(${NAME})/(${NAME}))?#(\\d+)`, 'im');

/** Removes the parts of a markdown text that GitHub ignores. */
function stripIgnored(text) {
  return String(text || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')                 // HTML comments (common in PR templates)
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, ' ') // code blocks
    .replace(/`[^`\n]*`/g, ' ');                       // inline code
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

/** If the description is the one of GitHub's "Revert" button, returns the reverted pull request. */
function revertedPr(body, current) {
  const m = PR_REVERT_RE.exec(String(body || ''));
  if (!m) return null;
  return { owner: m[1] || current.owner, repo: m[2] || current.repo, number: Number(m[3]) };
}

function refKey({ owner, repo, number }) {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
}

module.exports = { parseClosingRefs, revertedSha, revertedPr, refKey, stripIgnored };
