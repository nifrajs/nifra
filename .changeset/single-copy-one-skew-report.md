---
"@nifrajs/core": patch
---

The single-copy registrar reports the packages a linked tree skews together in one warning: both `node_modules` folders, both versions, the package list and the fix. A linked repository on another release skews every declared package at once, and each process (every CLI command included) printed one near-identical block per package. A single skewed package keeps its own report, and strict mode throws the combined text.
