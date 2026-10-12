---
"@nifrajs/core": minor
"@nifrajs/edge": minor
---

A body-schema route now refuses a urlencoded, multipart or `text/plain` body whose `Origin` names another site, with `403 { ok: false, error: "forbidden_origin" }`, before the body is read. A body-schema route reads urlencoded as well as JSON, and a form on any site can post urlencoded with the visitor's cookies and no preflight, so a route written for JSON took cross-site form posts. The JSON agent, A2A and AG-UI mounts had the same opening. Same-origin posts, requests without an `Origin` such as server-to-server calls, and `Origin: null` with `Sec-Fetch-Site: same-origin` (a form under `Referrer-Policy: no-referrer`) still pass. JSON bodies are unchanged: a browser preflights them, so CORS decides.

A frontend on another origin that posts forms or `FormData` to the API, or an identity provider's `form_post` callback, now needs its origin in the new `formOrigins` server option: an array of exact origins, or a function that receives the `Origin`. `@nifrajs/edge` takes the same option. `isSameOriginForm` is exported next to `isSameOriginRequest`, which now accepts anything with a `url`.
