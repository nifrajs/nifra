---
"@nifrajs/cli": patch
---

Make `NF-C010` (workspace-linked dist older than its source) actually fixable.

The `workspace-dist.rebuild` recipe resolved the package through the project-contained path check, but a
workspace link points outside the project by definition - the only kind of install that can go stale - so
the check rejected every package the diagnostic can name and `nifra fix --code NF-C010` was a silent
no-op. Resolution now goes through the same lookup the staleness scan uses (package name -> the project's
own `node_modules` chain -> realpath), refuses with a stated reason (registry install, no `build` script,
not installed) instead of reporting nothing, and surfaces the package's own build failure.

`nifra check` now names the directory and script in the warning (`cd ../pkg && bun run build`) instead of
"usually `bun run build` in its directory", and `doctor --json` gained `packageDir` and `buildScript` on
each stale-dist finding. `nifra fix` gained a `failed` array so one recipe that cannot act reports why
without cancelling the rest of the run.
