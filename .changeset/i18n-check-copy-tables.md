---
"@nifrajs/cli": minor
---

`nifra i18n check` checks copy tables: when the entry exports a `copy` from `defineCopy()` (with or without `catalogs`), it finds that definition's tables across the project's source, turns them into a catalog per locale and runs every catalog check on them, reporting each table at its `file:line`. Two tables with one id, an id that nests under another, and a table key that a catalog also uses are errors; a table or registry it cannot read statically is a warning that says why.
