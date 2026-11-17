# Nifra check - GitHub Action

Runs `nifra check --json` on a pull request and turns the result into three things: inline annotations, a job summary, and one PR comment that is updated on every push instead of spawning a new comment each time.

This is the CI half of making the contract gate part of the default path. The other half is the scaffold's `build` script, which now runs `nifra check` and `nifra assure` before `nifra build`.

## Usage

```yaml
name: nifra

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write # only needed for the PR comment

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<pinned-sha>
        with:
          persist-credentials: false

      - uses: nifrajs/nifra/action@v1
        with:
          nifra-version: "5.14.0" # pin this; "local" uses the project's installed CLI
          fail-on: error
```

If you do not want the bot comment, drop `pull-requests: write` and set `comment: "false"`. Annotations and the job summary use only the default token and work on fork PRs.

## Inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `github-token` | `github.token` | Token for the comment API. Needs `pull-requests: write`. |
| `working-directory` | `.` | Directory holding `nifra.config.ts` / `nifra.check.json`. |
| `nifra-version` | `latest` | `bunx @nifrajs/cli@<version>`. Use `local` to use the project's pinned CLI. |
| `bun-version` | `1.4.4` | Bun used for the CLI and the parser. |
| `fail-on` | `error` | `error`, `warning`, or `never`. Any other value fails the step. Parse errors and unexpected CLI exits always fail. |
| `comment` | `true` | Post/update a single PR comment. |
| `summary` | `true` | Append the report to `$GITHUB_STEP_SUMMARY`. |
| `annotations` | `true` | Emit `::error` / `::warning` annotations for findings with a file. |
| `marker` | `<!-- nifra-check:v1 -->` | Hidden marker used to find the previous comment. |

## Outputs

`ok`, `failed`, `errors`, `warnings`, `infos`, and `findings` (a JSON array of normalized findings, capped at 100 findings, 3 evidence entries each, and 100 KB, so it fits in one environment variable). It is not the full report: the job summary shows at most 60 findings and may stop earlier to fit its size limit, and annotations cover only findings with a file inside the repository. A run with more findings than fit has no complete list in any output; the CLI's own `nifra check --json` is the source for that.

`findings` contains text from the checked project. Never interpolate it into a `run:` script (`${{ steps.x.outputs.findings }}`); pass it through `env:` and read it as data.

## Security notes

- Use this action on `pull_request`, never `pull_request_target`. The CLI loads the project's own config and code, so on `pull_request_target` it would run untrusted PR code with a write token.
- Pin `nifra-version` to an exact version. `latest` works but logs a warning, because an unpinned CLI runs on every pull request. `local` runs the project's installed CLI and never downloads one.
- The PR comment is only updated when its author is a bot or a repository owner, member, or collaborator, so a stranger cannot plant the marker to block updates.
- Finding text is escaped (markup, `@mentions`, newlines) before it reaches the comment, summary, or annotations.

The finding shape mirrors the CLI's stable `Diagnostic` type: `code`, `severity` (`error` / `warn` / `info`), `message`, optional `file`, `line`, `evidence[]`, `fix: { recipe, command? }`, and `verify`.

## Behavior notes

- `nifra check` exits 0 on pass and 1 when there are error findings. Other exit codes mean the CLI itself failed; the action surfaces stderr and fails regardless of `fail-on`.
- A hard CLI failure emitted as `{ ok: false, error }` is shown as one synthesized `NIFRA_CHECK_ERROR` finding, so a broken run never looks like a green one.
- Comments are matched by the hidden marker. Re-running on the same PR patches the existing comment.
- Fork PRs: `GITHUB_TOKEN` is read-only there, so the comment step is skipped (`continue-on-error`). Annotations and the summary still run.
- No `@actions/*` dependency and no install step: the parser is plain Bun and uses the runner's preinstalled `gh`.

## Publishing as `nifrajs/check@v1`

This directory is self-contained. To expose the short handle, copy the contents of `action/` to the root of a new `nifrajs/check` repository and tag `v1`. In this monorepo the same files are addressable as `nifrajs/nifra/action@v1`. Move the major tag deliberately when the action's inputs or behavior change.

Creating the repository, tagging, and publishing are release actions and require explicit authorization; they are not performed by the implementation here.

## Local verification

```sh
bun test action/test
```

The tests cover the real `--json` shape, the legacy `fix: string` form, `{ ok: false, error }` hard failures, `fail-on` modes, markdown/annotation escaping, and fail-closed parsing.
