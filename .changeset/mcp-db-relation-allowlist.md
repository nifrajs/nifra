---
"@nifrajs/mcp-db": patch
---

The table allowlist is now checked against the SQL the query actually names, not only against SQLite's
query plan. A plan row reports the alias as its scan target, so `FROM "users" AS habits` planned as
`SCAN habits` and passed an allowlist that exposed `habits` but not `users`. A small tokenizer now
reads every relation after `FROM`/`JOIN` before the query runs - it handles all four SQLite identifier
quotings and the keyword-adjacent form (`FROM"users"`) a whitespace-anchored pattern cannot, drops
string literals and comments so text can never be read as SQL, and excludes CTE names. The plan check
still runs afterwards, and now resolves a schema-qualified `SCAN main.habits` to `habits` rather than
rejecting it as a table named `main`.

`maxResultBytes` is enforced on the encoded UTF-8 byte length of the whole payload, envelope included,
rather than on the JS string length of the rows alone - a multi-byte result could exceed the cap it
had just been measured against. A payload still over the cap after halving down to zero rows is an
error rather than an oversized response.

Authorization moves onto `@nifrajs/mcp`'s new `authorizeMessage` seam, so a `run_query` call is
authorized from the message the server already parsed instead of from a second `request.clone().json()`
read of the body.
