---
"@nifrajs/coding-agent": patch
---

`nifra-agent` loads `.nifra/extensions/**` only when started with the new `--extensions` flag. An extension's top-level code runs as soon as it is imported, before its `capabilities` can be refused, so starting the agent in a cloned repository no longer runs that repository's code.
