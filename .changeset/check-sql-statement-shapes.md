---
"@nifrajs/cli": patch
---

`nifra check`'s interpolated-SQL rule (NF-C006) now reads the ways a statement reaches a driver that it used to miss:

- A statement held in a `var` or a reassigned `let`, or built up in steps (`let q = "SELECT …"; q += \` AND name = '${name}'\``). The rule checks every value assigned to the variable.
- A pg or mysql2 config object (`{ text }` or `{ sql }`).
- node-sqlite3's `all`/`get`/`each` and pg-promise's `any`/`one`/`none`/`many` and related calls. These names are common outside SQL, so these calls, and bare calls such as a destructured `query(…)`, only flag text that starts like a statement.
- A statement passed through `String(…)`, `.trim()`, `.toString()`, `.concat(…)` or `[…].join(…)`.
- A template that only joins values (`` `${where}` ``).
- A template-literal method key (`` db[`query`](…) ``).
- A same-file function that passes one of its parameters to a query. Its callers are now checked.

A `sql` tag that the same file defines as a function is no longer trusted as a driver's binding tag. A `nifra-expect NF-C006` marker now has to sit in a comment; inside a string the call passes, it no longer silences the finding.
