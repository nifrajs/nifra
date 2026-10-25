---
"@nifrajs/core": patch
"@nifrajs/schema": patch
---

`responseContract()` judges a `Date` in a route's payload as the ISO string JSON writes for it. A field declared `t.string({ format: "date-time" })` that holds a `Date`, as a database driver returns a timestamp, now passes `enforce` and no longer logs a violation in `warn`, at the top of the payload, nested, in a list, and under `extra: "strip"`. A `Date` where the schema declares `t.date()` is still judged as a `Date`. A schema without `jsonSchema` (zod, valibot) is still shown the `Date` itself. A `Date` where the schema declares neither a string nor `t.date()`, such as an object, is now judged as the string it is sent as.
