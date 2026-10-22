---
"@nifrajs/schema": patch
---

`t.object`, `t.looseObject`, `t.query`, `t.cookies` and `t.headers` refuse a field named `__proto__`
with a `TypeError`, as `t.form` already does. That key replaced the properties' prototype instead of
declaring a field, so the field was left out of the schema without a word.
