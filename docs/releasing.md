# Releasing

Releases are prepared on a dedicated `release/<name>` branch. `main` is never used as the staging
area for versioning, and the release workflow never creates a second Version Packages pull request.

## Prepare one release

Start from the latest `main` and create the release branch:

```bash
git fetch origin main
git switch main
git pull --ff-only origin main
git switch -c release/2026-09-29
```

Bring the reviewed release work onto that branch, then create or review its Changesets:

```bash
bun run changeset
bun run release:prepare
git diff --check
git add .
git commit -m "chore(release): prepare 2026-09-29"
git push --set-upstream origin release/2026-09-29
```

`release:prepare` refuses to run on `main`, requires a clean tree and pending Changesets, then runs
the repository's version script. The resulting package versions, changelogs, lockfile, and generated
artifacts belong to the single release pull request.

## Merge and publish

Open one pull request from `release/<name>` to `main`. The release workflow validates the generated
versions and runs the full release verification; the Windows job also runs for release pull requests.
Merge only after that PR, CI, CodeQL, and review are green.

After the merge, the publish job checks GitHub's commit-to-pull-request association and proceeds only
when the exact validated commit came from a merged `release/<name>` pull request whose exact head
commit has a successful `release-verification` check. Publishing and deployment are serialized across
release runs. It publishes the already-versioned packages and performs registry/site smoke checks.
Ordinary `main` merges are a no-op and cannot create a release PR or publish packages.

Protect `main` with pull-request-only changes, required status checks, stale-review dismissal, and
no force-push permission. Do not grant publish credentials to pull-request workflows.
