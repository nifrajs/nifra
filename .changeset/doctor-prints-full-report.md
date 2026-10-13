---
"@nifrajs/cli": patch
---

`nifra doctor` prints its full report again: the bundler, the dependency scan scope, production readiness, each undeclared import and duplicate install with its fix, and the advisories (a CLI that differs from the project's nifra, mixed nifra versions, stale `file:` entries in `bun.lock`, stale MCP pins). It had printed only whether it passed, while `--json` and the MCP tool carried the detail.
