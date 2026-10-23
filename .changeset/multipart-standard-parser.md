---
"@nifrajs/core": minor
---

`multipartBody` parses a form itself, by the Fetch standard's `multipart/form-data` parser, instead
of handing the bytes to the runtime's own `formData()`. Those parsers disagreed: a body delimited by
bare line feeds, a part with no name, an upper-case `NAME`, an escaped or percent-encoded name, a
`filename*`, or bytes after the closing delimiter was a form on one runtime and refused or emptied
on another, and a file part with no `Content-Type` was `text/plain`, `application/octet-stream` or
`text/plain;charset=utf-8` by runtime. Now every runtime reads the same parts: a disposition must be
written as `form-data; name="..."` with an optional `; filename="..."`, `%0A`, `%0D` and `%22` in a
name are restored, a file's type defaults to `text/plain`, and a body led by a preamble is refused.
A file part named `filename=""` with content is a file called `file` everywhere. Parsing is also
faster on every runtime: 9-32% on Bun, 28-53% on Node, 70-76% on Deno for the shapes measured.
