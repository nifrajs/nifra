---
"@nifrajs/cli": patch
---

`nifra upgrade --write` no longer runs `nifra check` against packages its edits have not installed: that check read the release being left, so it could fail on a mix of versions or pass on the old one. While package.json pins or bun.lock entries it changed are not installed, or `node_modules` holds a nifra package at another version, it prints the install command (`bun install`, or `pnpm`, `yarn` or `npm install` by lockfile) and `nifra check` to run after it, and exits 0, so `nifra upgrade <version> --write && bun install` chains. `--json` reports `install` in place of `check`. The hook-scope diff waits for the install too: the report from before the edits is saved for `nifra routes --hooks --since`.
