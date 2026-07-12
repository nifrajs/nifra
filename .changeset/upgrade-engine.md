---
"@nifrajs/cli": minor
---

Add `nifra upgrade <version>`: an executable, per-release upgrade runner. A recipe declares the
mechanical edits a target version needs — a dependency-pin sweep (sets every matching `@nifrajs/*`
dependency to the target version across the workspace, preserving each spec's `^`/`~`/exact style and
skipping `workspace:`/`link:` specs) and exact import-specifier moves — and the runner applies them
`detect → transform → verify`, reusing the existing `nifra check` gate rather than adding a new one.
Dry-run by default (`--write` applies, `--no-verify` skips the check, `--list` shows targets); fail-closed
on an unknown version or a missing package.json; deterministic and idempotent. Ships the 1.8.0 recipe.
Transforms are intentionally string/specifier-level — structural (AST) codemods are deferred until a
recipe needs one.
