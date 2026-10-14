---
"@nifrajs/schema": patch
---

`compileSchema` refuses `t.form` and any schema whose `validate` does more than check its `jsonSchema`. It detected coercion only through the query schemas' marker, so a text-only form compiled into a validator without the form's coercion, list defaults or multipart reader, and a route using it rejected every real form post.
