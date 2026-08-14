---
"@nifrajs/cli": patch
---

`nifra doctor` now flags a running CLI whose feature version differs from the `@nifrajs/cli` (or
`@nifrajs/core`) the project installs. A stale global or `bunx`-cached binary answering about a
project it does not match returns types, checks, and docs that describe a surface the code does not
have, and every answer still reads as authoritative. The finding is advisory - it names both versions
and points at the project's own CLI, but never fails the gate on its own, since a version mismatch of
the binary is an environment condition rather than a defect in the project. Reported only when the
command supplies its own version, so callers that already annotate drift (the MCP server) do not
double-report; the `--json` shape gains an optional `toolingDrift` field. Patch differences are
ignored - they never change the described surface.
