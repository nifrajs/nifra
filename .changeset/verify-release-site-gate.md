---
"@nifrajs/cli": patch
---

`nifra verify --release` runs a `site` gate, `bun run check:site`, after `sitemap`. A project without that script reports the gate as undeclared, as it does for the other repository gates.
