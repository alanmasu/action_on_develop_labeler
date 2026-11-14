# action_on_develop_labeler

GitHub Action that adds the **`on develop`** label to issues when their fix lands on a branch that
is **not** the default one (usually `develop`), removes it when the fix is reverted, and can also
move the issue in a GitHub Project. Closing the issue is still GitHub's job, when the code reaches
the default branch.

## What it recognizes (same rules as GitHub)

| In a commit message or pull request description | Effect |
|---|---|
| `Fixes #12`, `closes: #12`, `RESOLVED #12` (all 9 keywords) | label on #12 |
| `Fixes owner/repo#12` | issue in another repository (needs `token`) |
| `Fixes https://github.com/owner/repo/issues/12` | same as above |
| `Fixes #1, #2` | only #1: every reference needs its own keyword |
| text in `` `code` ``, code blocks or `<!-- comments -->` of a **pull request description** | ignored (in commit messages it counts, as on GitHub) |
| issue linked manually from the pull request *Development* sidebar | label |
| `Revert "..."` commit, or pull request created with the **Revert** button | label removed |
| revert of a revert | label added again |
| revert of a merge commit | label removed from every issue of that pull request |

Ignored: closed issues, references to pull requests, issues with the `skip-label`
(default `do not close`), tags. Pushes to the default branch are handled as a release (below). If the label does not exist in the
repository, it is created.

### At release

When `develop` is merged into the default branch (needs `main` in the `push` branches):

- the label is **removed** from every released issue;
- issues fixed only by a **pull request description** (`Closes #12` in a pull request merged into
  `develop`) are **closed** with a comment: GitHub does not close them, because that pull request
  did not target the default branch. Only issues that still have the label are closed, and a
  description edited after the merge (or that cannot be checked) is not used: anyone who opened
  the pull request, also from a fork, can edit it;
- issues that GitHub closes because a commit with `Fixes #N` reached the default branch, but
  whose fix had been **reverted**, are **reopened** with a comment (needs the `issues: [closed]`
  trigger).

Only the commits of that push are considered, so a hotfix pushed to the default branch does not
touch issues that are still waiting on `develop`. A **forced** push to the default branch skips
the cleanup, with a warning.

### Known limits

- Reverts are recognized by git's default message (`This reverts commit <sha>`); a revert whose
  message was rewritten by hand is not.
- In pull request descriptions, code (fenced, indented or inline) and HTML comments are ignored.
  When in doubt the action ignores more than GitHub would: a missed label is safer than a wrong
  closure.
- A pull request **squash-merged into `develop`** whose commits include a fix and its revert: with
  the squash message listing the commits (GitHub's "commit messages" setting), GitHub closes the
  issue at release because the keyword is in that message, and the action does not reopen it,
  although no fix is left. See issue #6.
- If `develop` is **squash-merged** into the default branch, the pull request merge commits never
  reach it, so issues fixed only by pull request descriptions are not closed at release.
- Very large pushes are checked up to 3000 commits; the first push of a new branch only sees the
  commits listed in the push event. Both cases are reported as warnings.
- When the same `do not close` issue is referenced both by a commit and by the description of the
  pull request that merges it, the push run and the `pull_request_target` run may, rarely, both
  post the warning comment.

### Issues labeled `do not close`

GitHub closes an issue when a `Fixes #N` reaches the default branch, whatever its labels. For
issues with the `skip-label` the action:

1. **warns early**: when a closing keyword for the issue reaches `develop`, it comments once on
   the issue (and shows a warning in the run) saying that the release will close it;
2. **reopens it**: when a commit or a pull request closes it, it reopens it and comments with what
   closed it. Issues **closed by hand stay closed**. Needs the `issues: [closed]` trigger.

Remove the label by hand when the issue is actually solved.

Use `Refs #12` instead of `Fixes #12` for partial fixes: it links the issue without closing it.

## Usage

```yaml
on:
  push:
    branches: [develop, main]
  pull_request_target:
    types: [closed]
    branches: [develop]
  issues:
    types: [closed]

permissions:
  contents: read
  issues: write
  pull-requests: read

jobs:
  label:
    runs-on: ubuntu-latest
    steps:
      - uses: alanmasu/action_on_develop_labeler@v1
```

Complete examples in [`examples/workflows/`](examples/workflows/).

| Input | Default | |
|---|---|---|
| `label` | `on develop` | Label to apply |
| `label-color` | `8521fc` | Used only if the label is created |
| `label-description` | `Fix merged into develop, waiting for release` | Used only if the label is created |
| `skip-label` | `do not close` | Issues with this label are ignored. Empty = disabled |
| `warn-skipped` | `true` | Comment once on skip-labeled issues referenced by a fix on `develop` |
| `reopen-skipped` | `true` | Reopen skip-labeled issues closed by a commit or pull request |
| `release-cleanup` | `true` | On the default branch: remove the label, close issues fixed only by pull request descriptions |
| `reopen-reverted` | `true` | Reopen issues closed by a commit whose fix was reverted |
| `token` | `github.token` | Needs access to other repositories for `Fixes owner/repo#N` |
| `project-url` | | Project to update, `https://github.com/users/<user>/projects/<n>` or `.../orgs/<org>/projects/<n>` |
| `project-token` | | Token with access to the project (`GITHUB_TOKEN` cannot) |
| `status-field` | `Status` | Single select field to update |
| `status-on-develop` | | Option set when the label is added |
| `status-on-revert` | | Option set when a revert removes the label. Empty = leave it |
| `status-on-reopen` | | Option set when a skip-labeled issue is reopened. Empty = leave it |
| `dry-run` | `false` | Only report what would change |

Outputs: `labeled`, `unlabeled`, `skipped`, `reopened`, `released` (JSON arrays of `owner/repo#N`). Each run also writes a
summary on the job page.

### With a project

Every project has its own columns, so the field and option names are parameters. The action
checks them at start-up and stops with the list of available fields or options if one is wrong,
before touching any issue. Only issues **already in the project** are moved; to add new issues to
the project automatically use [`actions/add-to-project`](https://github.com/actions/add-to-project).

Token for `project-token`, saved as the `PROJECT_TOKEN` secret:

| Project owned by | Token |
|---|---|
| a user | classic PAT with `project` scope (+ `repo` for private repositories) |
| an organization | fine-grained PAT owned by the organization with *Projects: read and write*, or a GitHub App |

A classic PAT with `project` and `repo` covers both a user and an organization.

## Releasing

```bash
git tag -a v1.0.0 -m "v1.0.0" && git push origin v1.0.0
git tag -f v1 v1.0.0 && git push -f origin v1     # major tag follows the latest 1.x
```

## Development

```bash
npm test
```
