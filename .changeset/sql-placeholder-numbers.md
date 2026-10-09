---
"@nifrajs/cli": patch
---

`nifra check`'s interpolated SQL rule (NF-C006) reads a `$${...}` span as a Postgres placeholder number when the expression provably evaluates to a number: arithmetic other than `+` (which always yields one), a `+` of two numbers, the index parameter of an array callback (`map`, `forEach`, `Array.from` and the like) that is never reassigned, a `const` or `for` counter that only ever holds numbers, `params.push(...)`, `Number`/`parseInt`/`parseFloat`/`Math.*`, and the `.length` of an array a local binding builds from a literal. `xs.map(fn).join(...)` and `Array.from(n, fn).join(...)` resolve when the callback's text does, so batch `VALUES ($1, $2), ...` and `IN ($1, $2, ...)` lists no longer need a `nifra-expect` comment, and a local array built with `.push(...)` of such text (a `WHERE` builder) resolves as well. A type annotation proves nothing, so a parameter typed `number` still flags.
