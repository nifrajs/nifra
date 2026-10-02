---
"@nifrajs/cli": minor
---

feat(cli): `nifra check` reports route data without an output schema

NF-C030 warns about a route backend half whose loader or action may return data without its
`loaderOutput` or `actionOutput`. NF-C031 is an error for an output schema that names a sensitive
field (`password`, `token`, `apiKey`, ...) without `t.declassified`.
