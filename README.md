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
(default `do not close`), pushes to the default branch, tags. If the label does not exist in the
repository, it is created.

Use `Refs #12` instead of `Fixes #12` for partial fixes: it links the issue without closing it.

## Usage

```yaml
on:
  push:
    branches: [develop]
  pull_request_target:
    types: [closed]
    branches: [develop]

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
| `token` | `github.token` | Needs access to other repositories for `Fixes owner/repo#N` |
| `project-url` | | Project to update, `https://github.com/users/<user>/projects/<n>` or `.../orgs/<org>/projects/<n>` |
| `project-token` | | Token with access to the project (`GITHUB_TOKEN` cannot) |
| `status-field` | `Status` | Single select field to update |
| `status-on-develop` | | Option set when the label is added |
| `status-on-revert` | | Option set when a revert removes the label. Empty = leave it |
| `dry-run` | `false` | Only report what would change |

Outputs: `labeled`, `unlabeled`, `skipped` (JSON arrays of `owner/repo#N`). Each run also writes a
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
