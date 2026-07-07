---
"@nifrajs/cli": minor
---

feat(cli): `nifra_check` / `nifra_test` MCP tools accept a `dir` to scope a subdirectory

The MCP server runs at the project root, so `nifra check` / `nifra test` always ran from there — no way to
target one app in a monorepo (a ShipNow pain: the root holds the builder + generated apps, but you want to
check just `app/`). Both tools now take an optional `dir` (relative to the root, e.g. `"app"` or
`"packages/api"`); the check/test runs against that subtree. Path-traversal-guarded — a `dir` that climbs
out of the root (`../`, an absolute path elsewhere) is rejected, not run.
