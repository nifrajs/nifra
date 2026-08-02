---
"@nifrajs/cli": minor
---

`nifra doctor` and `nifra check` now flag stale workspace dists. A workspace-linked dependency whose export map splits `bun` (source) from `default` (a `dist` artifact) serves live source to Bun but a build artifact to Vite's SSR runner and node consumers - and nothing in the dev loop rebuilds that artifact. Because `dist/` is gitignored, the drift never shows in a diff; it surfaces as a 500 inside the package's code and reads like an upstream regression. The new `stale-workspace-dist` rule compares each linked dependency's `default` target mtime against its newest source file and reports "rebuild <pkg>" with the lag (or "never built" when the artifact is missing). Advisory severity: it warns in the report and the `--json`/MCP diagnostics but never fails the gate, since a linked package's dist is legitimately behind while you are mid-edit. npm tarball installs are immutable and never flagged.
