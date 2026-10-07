---
"@nifrajs/cli": patch
"create-nifra": patch
---

fix(cli): `@nifrajs/cli` no longer depends on `create-nifra`. It ships its own copy of the agent-file generators, so installing the CLI pulls in only `@nifrajs/*` packages and a scoped release-age exclusion covers the whole tree.
