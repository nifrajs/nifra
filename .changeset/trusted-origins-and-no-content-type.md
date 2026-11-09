---
"@nifrajs/core": minor
"@nifrajs/middleware": minor
---

The origins a `cors()` list or predicate and a `csrf({ origins })` list name are now trusted for form posts, so a frontend those already allow no longer needs a second copy in `formOrigins`. `cors()` with `"*"`, the default, adds none, and the server's own `formOrigins` list is kept.

A route without a body schema now also refuses an unsafe request that has no content type, which `fetch` with `no-cors` sends, when its `Origin` names a site that neither `formOrigins`, `cors()` nor `csrf({ origins })` trusts. A request that carries a script-set `Authorization` header passes, since a browser preflights it; `Basic`, `Digest`, `Negotiate` and `NTLM` do not count, because a browser re-sends those from its auth cache with no preflight. An app that handles CORS outside nifra, such as a reverse proxy adding the headers, and takes bodyless cross-origin `POST`, `PUT`, `PATCH` or `DELETE` calls from a frontend without `Authorization` needs that frontend's origin in `formOrigins`.

Audit the origins you give `cors()` and `csrf({ origins })`: a named origin may now also post a form to this server's routes, whatever methods or credentials that CORS policy allows. The trust covers the server that installs the middleware; a parent that merges or groups it keeps its own `formOrigins`, and a web page action still checks the backend's `allowedOrigins`.
