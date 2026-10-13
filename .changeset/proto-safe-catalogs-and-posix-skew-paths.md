---
"@nifrajs/i18n": patch
"@nifrajs/cli": patch
---

`tablesToCatalogs()` builds every catalog and nested block with a null prototype, so a copy table id segment or a locale key named `__proto__` is an ordinary entry and never reaches `Object.prototype`. The copy scanner substitutes a tsconfig `paths` match into its target as written, so a `$&` in an import path stays literal. `nifra upgrade` prints a linked repository's path with forward slashes on every platform, in the blocker line and in the `cd` command it suggests.
