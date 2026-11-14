'use strict';

/**
 * Helpers for issues labeled with the skip label (default "do not close"):
 * an early warning comment when a fix references them, and detection of
 * closures caused by a commit or a pull request.
 */

const MARK_WARN = '<!-- action_on_develop_labeler:skip-warning -->';
const MARK_REOPEN = '<!-- action_on_develop_labeler:reopened -->';
const MARK_RELEASE = '<!-- action_on_develop_labeler:released -->';

function warnText({ skipLabel, source, branch, number, reopen }) {
  if (!source.startsWith('commit')) {
    // a pull request description: GitHub only closes issues from descriptions of pull requests
    // that target the default branch, and the release cleanup skips skip-labeled issues
    return [
      MARK_WARN,
      `This issue is labeled \`${skipLabel}\`, but ${source} merged into \`${branch}\` references it with a closing keyword.`,
      'It will stay open: the label keeps automations from closing it.',
      '',
      `Use \`Refs #${number}\` instead of \`Fixes #${number}\` for partial fixes.`,
    ].join('\n');
  }
  return [
    MARK_WARN,
    `This issue is labeled \`${skipLabel}\`, but ${source} on \`${branch}\` references it with a closing keyword.`,
    `When that change reaches the default branch, GitHub will close this issue` +
      (reopen ? ', and it will be reopened automatically.' : '.'),
    '',
    `Use \`Refs #${number}\` instead of \`Fixes #${number}\` for partial fixes.`,
  ].join('\n');
}

function revertedText({ closer, reverter }) {
  return [
    MARK_REOPEN,
    `Reopened automatically: this issue was closed by ${closer}, but that fix was reverted by commit ${reverter}.`,
  ].join('\n');
}

function releasedText({ source, branch, sha }) {
  return [
    MARK_RELEASE,
    `Closed automatically: fixed by ${source} and released to \`${branch}\` in ${sha}.`,
  ].join('\n');
}

function reopenText({ skipLabel, closer }) {
  return [
    MARK_REOPEN,
    `Reopened automatically: this issue is labeled \`${skipLabel}\` and was closed by ${closer}.`,
    '',
    'Remove the label when the issue is actually solved.',
  ].join('\n');
}

/** True if one of the issue comments contains the marker. */
async function hasMarker(github, { owner, repo, number }, marker) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner, repo, issue_number: number, per_page: 100,
  });
  return comments.some((c) => String(c.body || '').includes(marker));
}

/**
 * What closed the issue the last time: { text: "commit abc1234", sha } or
 * { text: "pull request #12", sha: null }, or null if it was closed by hand. GraphQL knows the closer of every closure; the REST
 * events API only knows commits, so it is the fallback.
 */
async function findCloser(github, { owner, repo, number }) {
  try {
    const res = await github.graphql(
      `query($o: String!, $r: String!, $n: Int!) { repository(owner: $o, name: $r) { issue(number: $n) {
         timelineItems(last: 1, itemTypes: [CLOSED_EVENT]) { nodes { ... on ClosedEvent {
           closer { __typename ... on Commit { oid abbreviatedOid } ... on PullRequest { number } } } } } } } }`,
      { o: owner, r: repo, n: number }
    );
    const nodes = res.repository.issue.timelineItems.nodes || [];
    const closer = nodes.length ? nodes[nodes.length - 1].closer : null;
    if (closer && closer.__typename === 'Commit') return { text: `commit ${closer.abbreviatedOid}`, sha: closer.oid || null };
    if (closer && closer.__typename === 'PullRequest') return { text: `pull request #${closer.number}`, sha: null };
    if (nodes.length) return null; // closed event without a closer: closed by hand
  } catch {
    // fall back to REST below
  }
  const events = await github.paginate(github.rest.issues.listEvents, {
    owner, repo, issue_number: number, per_page: 100,
  });
  const last = events.filter((e) => e.event === 'closed').pop();
  return last && last.commit_id ? { text: `commit ${last.commit_id.slice(0, 7)}`, sha: last.commit_id } : null;
}

module.exports = { MARK_WARN, MARK_REOPEN, MARK_RELEASE, warnText, reopenText, revertedText, releasedText, hasMarker, findCloser };
