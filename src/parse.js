'use strict';

/**
 * Parsing delle "closing keywords" con le stesse regole di GitHub:
 *
 *   KEYWORD #N                  -> issue nella stessa repo
 *   KEYWORD owner/repo#N        -> issue in un'altra repo
 *   KEYWORD https://github.com/owner/repo/issues/N
 *
 * - keyword: close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved
 * - maiuscole/minuscole indifferenti, i due punti sono ammessi ("Closes: #10")
 * - ogni riferimento vuole la SUA keyword: "Fixes #1, #2" chiude solo #1
 * - il testo dentro blocchi di codice, codice inline e commenti HTML viene ignorato
 */

const KEYWORDS = 'close[sd]?|fix(?:e[sd])?|resolve[sd]?';
const NAME = '[A-Za-z0-9_.-]+';

const REF_RE = new RegExp(
  '(?<![A-Za-z0-9_])' +                       // la keyword deve iniziare una parola
  `(?:${KEYWORDS})` +
  '(?:\\s*:\\s*|\\s+)' +                      // spazio e/o due punti
  '(?:' +
    `https?://github\\.com/(?<uOwner>${NAME})/(?<uRepo>${NAME})/issues/(?<uNum>\\d+)` +
    '|' +
    `(?:(?<owner>${NAME})/(?<repo>${NAME}))?#(?<num>\\d+)` +
  ')' +
  '(?![A-Za-z0-9_])',                         // "#12abc" non è un riferimento
  'gi'
);

const REVERT_RE = /This reverts commit ([0-9a-f]{7,40})/i;
const PR_REVERT_RE = new RegExp(`^Reverts (?:(${NAME})/(${NAME}))?#(\\d+)`, 'im');

/** Rimuove le parti di testo che GitHub non considera. */
function stripIgnored(text) {
  return String(text || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')                 // commenti HTML (tipici dei template PR)
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, ' ') // blocchi di codice
    .replace(/`[^`\n]*`/g, ' ');                       // codice inline
}

/**
 * Estrae i riferimenti da chiudere.
 * @param {string} text
 * @param {{owner: string, repo: string}} current repo in cui gira l'action
 * @returns {{owner: string, repo: string, number: number, key: string}[]}
 */
function parseClosingRefs(text, current) {
  const out = [];
  const seen = new Set();
  for (const m of stripIgnored(text).matchAll(REF_RE)) {
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

/** Se il messaggio è un revert creato da git, restituisce lo SHA del commit annullato. */
function revertedSha(message) {
  const m = REVERT_RE.exec(String(message || ''));
  return m ? m[1] : null;
}

/** Se la descrizione è quella del pulsante "Revert" di GitHub, restituisce la PR annullata. */
function revertedPr(body, current) {
  const m = PR_REVERT_RE.exec(String(body || ''));
  if (!m) return null;
  return { owner: m[1] || current.owner, repo: m[2] || current.repo, number: Number(m[3]) };
}

function refKey({ owner, repo, number }) {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
}

module.exports = { parseClosingRefs, revertedSha, revertedPr, refKey, stripIgnored };
