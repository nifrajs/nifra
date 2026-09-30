---
"@nifrajs/core": patch
---

fix(core): a request method is matched exactly. Method tokens are case-sensitive, so a request sent
as `post` or `Patch` does not reach a `POST` or `PATCH` route: it answers `405` with `Allow` when the
path has routes and `404` when it has none. `Router.find` from `@nifrajs/core/router` follows the
same rule.

A token no route can be registered under - anything other than uppercase letters, digits and
hyphens, a letter first, at most 32 characters - is answered by the route table alone. `onRequest`
hooks, handlers mounted with `mount` or `mountFetch`, and the WebSocket upgrade lane do not run for
it, so code that tests `request.method` never reads a token it would not recognise.

This is visible on a runtime that hands the token over as sent, such as Deno. Bun and Node refuse
such a request before it reaches the app.
