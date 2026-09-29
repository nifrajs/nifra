---
"@nifrajs/cli": patch
---

fix(cli): `nifra mcp` no longer answers for a different nifra release than the project installs. When
the project has its own `@nifrajs/cli` at another version, the server hands the stdio session to the
project's `node_modules/.bin/nifra mcp` (passing an explicit project dir through). When that is
impossible - no project CLI, no linked bin, or a hand-off that still disagrees - `nifra_check`,
`nifra_types`, `nifra_docs`, `nifra_assure` and `nifra_contracts` fail with the version split and the
command that fixes it, while release-independent tools keep working.
