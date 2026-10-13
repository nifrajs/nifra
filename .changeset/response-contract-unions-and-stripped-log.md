---
"@nifrajs/core": minor
---

`responseContract(mode, { extra: "strip" })` projects a union whose object branches all require one key holding literals no two branches share (`ok: true` / `ok: false`, `kind: "a"` / `kind: "b"`): each value is projected onto the branch its tag names. A union with one object branch and one array branch projects both. Unions where more than one branch could accept a value are still left to the validator.

`responseContract("enforce", { logStripped: true })` logs the names of the fields that never reached the wire, whether `extra: "strip"` or a stripping validator dropped them: nested fields as `user.email`, array items as `items[].cost`, once per route for each distinct set of names. Values are never logged.
