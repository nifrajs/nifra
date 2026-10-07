---
"@nifrajs/cli": minor
---

`nifra schemas` drafts `loaderOutput` and `actionOutput` from each loader's and action's TypeScript return type. A dry run reports what every route needs; `--write` puts a schema, marked `nifra:generated`, above each loader or action that has none, leaving out credential-like field names and values that are not JSON. Marked schemas are kept in step with the return type on later runs, and `nifra check` reports NF-C033 when one has drifted. Hand-written schemas are never rewritten: the report lists the returned fields each one drops, by path. Works with TypeScript 5, 6 and 7.
