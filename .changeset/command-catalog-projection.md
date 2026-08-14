---
"@nifrajs/cli": minor
---

`nifra --help` now lists a stable project command catalog, and the CLI, the `nifra mcp` project tools,
and the generated `@nifrajs/cli` card all describe those commands - `check`, `assure`, `levels`,
`capabilities`, `manifest`, `routes`, `context`, `doctor`, `fix`, `snapshot`, `diff`, `contracts`,
`sync-manifest`, `sync-routes` - from one projection, so a command's name, one-line summary, and input
schema can no longer drift between the three surfaces. A parity check fails the build if they do.
`nifra verify` and `nifra prove` are intentionally excluded and stay hand-rolled.

`nifra fix` now prints a human summary by default and reserves JSON for `nifra fix --json`; the `--json`
shape gains an `ok` field alongside `changed` and `diagnostics`. A script that parsed plain `nifra fix`
output as JSON must pass `--json`.

Structured `--json` results carry a versioned envelope, and the reader still accepts the prior
un-enveloped shape, so an existing consumer keeps working across the change.
