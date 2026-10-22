---
"@nifrajs/core": patch
---

`responseContract()` judges what `JSON.stringify` writes. A value's `toJSON` hooks are applied before
it is validated, so a hook that adds an undeclared field fails a closed schema under `enforce` and is
named under `warn`, while a hook that writes the declared shape, such as a value object written as a
string, passes. A `Date` is still validated as a `Date`.

A route with an `around` hook or an `onValidationError` hook honors `formOrigins` for cross-origin
form posts, as every other body lane does.
