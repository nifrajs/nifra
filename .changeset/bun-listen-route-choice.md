---
"@nifrajs/core": patch
---

fix(core): on Bun, `listen()` picks the same route for a request as `app.fetch()` does, and as every
other runtime does. Three cases:

- A path segment that mixes literal text and a parameter matches only what it is written to match.
  `/files/:name.json` serves `/files/a.json` with `params.name` of `"a"`, and answers `/files/a` with
  `404`.
- When the most specific route for a path has no handler for the request's method, the answer is
  `405` with an `Allow` header. With `POST /users/me` and `GET /users/:id`, `GET /users/me` is `405`.
- A route that is more specific early in the path takes its requests ahead of a broader one. With
  `GET /admin/*rest` and `GET /:section/:page`, `GET /admin/users` is served by `/admin/*rest`.

A route none of these touch is still served from Bun's own route table.
