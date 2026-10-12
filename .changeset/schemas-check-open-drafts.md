---
"@nifrajs/cli": minor
---

`nifra schemas --check` exits `1` when a loader or action has no output schema, a generated one is stale, or a draft admits any value, for CI. A value typed `any` or `unknown` still drafts as `t.json()`; `nifra schemas` and `nifra migrate layout` now list each such path, and NF-C030 warns on the line in a generated schema. A drafted union no longer adds `t.optional(t.null())` for the keys only other branches declare.
