---
"@nifrajs/core": patch
---

A body the app's own `c.req.formData()` cannot parse (a multipart body with no closing delimiter or
the wrong boundary, a part without a name, a body that is not a form) answers the client's 400
`invalid_form` when the error escapes the handler, as `c.req.json()` answers `invalid_json`. It was a
logged 500. The app still sees the `TypeError` `Request.formData()` rejects with, and `onError`
hooks see it first.
