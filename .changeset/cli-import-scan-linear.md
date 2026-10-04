---
"@nifrajs/cli": patch
---

The import scanners behind `nifra check`, `nifra doctor` and the capability provenance check read an import or re-export clause by its grammar: a default binding, then `* as name` or a `{ … }` list. Previously they scanned lazily to the next `from`. A long module with many `export const` lines and no string literal now scans in linear time; 16,000 lines took over 4 seconds before. Each re-export is attributed to its own line, and minified `import{a}from"x"` is read too.
