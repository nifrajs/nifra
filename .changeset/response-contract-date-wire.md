---
"@nifrajs/schema": minor
"@nifrajs/core": patch
"@nifrajs/client": patch
---

`t.date()` is a `Date` in code and an RFC 3339 `date-time` string on the wire, in a request and a response alike.

- A request `body`, `query` or `params`, and a server function's `input`, that declares `t.date()` takes the string and hands the handler a `Date`. Only places the schema declares `t.date()` are read as dates: a `t.string()` holding a date-like string stays a string. In a union, the first branch that accepts the value decides.
- A route `response` may declare `t.date()` for a timestamp column: the handler returns the `Date` or the string, and the JSON carries the string.
- `responseContract()` judges a `Date` as the ISO string JSON writes for it when the schema carries its JSON Schema (every `t` schema), so a `Date` under `t.string({ format: "date-time" })` passes `enforce` and logs nothing in `warn`, at any depth and under `extra: "strip"`. A schema without one (zod, valibot) is still shown the `Date`.
- The `date-time`, `date` and `time` string formats follow RFC 3339 in full: a day the calendar lacks (`2026-02-30`), an hour of `24` and an offset past `23:59` fail.
- A `c.json(...)` reply on a route with a contract calls each `toJSON` hook once, a `Date`'s included, and sends the value the contract judged.
- The typed client writes a `Date` in `query` as its ISO string.
