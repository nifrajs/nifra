---
"@nifrajs/cli": patch
---

`nifra upgrade` prints what changes across 5.2.0 and 5.3.0. For 5.2.0: closed header schemas read only declared names, and `extra: "strip"` projects tagged unions. For 5.3.0: the development hook audit reports more ordering mistakes (and throws on them under `unusedScopedHooks: "error"`), NF-C043, the wider capability walk, the unpinned MCP launch, and the linked-repository refusal.
