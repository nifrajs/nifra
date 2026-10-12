---
"@nifrajs/web": patch
---

A page action now refuses a POST whose `Origin` header names another site, with `403`: plain text for a form submit and `{ ok: false, error: "forbidden_origin" }` for a client-router submit. This runs before middleware, gates or the action. Until now, any site could auto-submit a form to an action and the browser sent the visitor's cookies with it. Server functions and WebSocket routes already refused that. A request with no `Origin`, such as one from a server, still passes. Same-origin is judged from the request URL's host, so a proxy must forward `Host`. A route that accepts posts from another site, such as an identity provider's `form_post` callback, exports `allowedOrigins` from its backend file: an array of exact origins, or a function `(origin: string | null) => boolean`.
