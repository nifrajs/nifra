---
"@nifrajs/schema": patch
---

A schema key named after an `Object.prototype` member (`constructor`, `toString`, `valueOf`, `hasOwnProperty` and the rest) is absent from a value that does not carry it, as any other key is. An optional one no longer fails `{}` against the inherited member (`Expected array` at `["constructor"]`) in `t.object`, `t.query`, a `fromTypeBox` schema or `compileSchema` output, on the compiled and the eval-free validator alike, so a body, query, params or enforced response contract holding one no longer answers 422 or 500 for a value without it. A coercing schema no longer writes the inherited member onto the input, and a required `unknown` or `any` key is no longer satisfied by it. A present key is checked as before. Such a schema validates a copy of the value whose plain objects have no prototype, so it costs more per call; a coercing one returns that converted copy and leaves a plain-object input untouched. Every other schema validates as before.
