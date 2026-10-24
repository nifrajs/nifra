---
"@nifrajs/core": patch
---

The single-copy registrar's version-skew warning says the second copy is installed, not that it
loads. It is computed from the installed trees, so it also appears for a package nothing imports.
