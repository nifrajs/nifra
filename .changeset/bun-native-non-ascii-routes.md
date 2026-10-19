---
"@nifrajs/core": patch
---

On Bun, `listen()` no longer throws `Invalid route ... Please encode all non-ASCII characters in the path` for a route such as `/café` or `/日本/:id`. Bun's route table now holds such a path under the percent-encoded spelling the portable router matches, so `listen()` answers it as `app.fetch` does.
