---
"@nifrajs/core": minor
"@nifrajs/edge": minor
---

feat(core): `notFound(handler)` from `@nifrajs/core/not-found` answers a request no route matched,
in place of the default `404` body. Apply it with `use()`:

```ts
import { notFound } from "@nifrajs/core/not-found"

app.use(
  notFound(({ pathname, header }) => {
    if (header("accept")?.includes("text/html")) {
      return new Response("<h1>Nothing here</h1>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    }
    return undefined // the default { ok: false, error: "not_found" }
  }),
)
```

- It answers a `404` only. A path that exists under another method is still a `405` with `Allow`, a
  malformed path parameter is still a `400`, and a `404` a route or a mounted app returned is left
  alone.
- A `2xx` answer is sent as a `404`, keeping its body and headers. A `3xx`, `4xx` or `5xx` answer is
  sent unchanged. `undefined` keeps the default body. A thrown `Response` is an answer.
- The handler is given `method`, `url`, `pathname` (as sent, not percent-decoded), `headers`,
  `header(name)`, `signal` and `platform`. It is never given the request body.
- A throw, a rejection, or a returned value that is not a `Response` is logged once, honouring
  `errorLogDetail`, and answered with the plain `500` `internal_error` body.
- With `requestTimeoutMs` set, an async handler that outlives it has `signal` aborted and the request
  answered `503`. A deadline header on the request is not consulted for a request no route matched.
- The answer takes the normal response path: fixed response headers and `onResponse` hooks apply.
- One handler per server. A second `notFound()` throws, as does one applied inside a `group()` or
  after `listen()`. `merge()` does not carry a merged server's handler across.

To serve unmatched paths - a single-page app's shell, another app behind this one - register a
wildcard route or a mount: those are matches, with their own status, the request body, and the full
route lifecycle.

feat(edge): `notFound(handler)` from `@nifrajs/edge` builds the same handler for the compact server,
passed as an option: `server({ notFound: notFound(handler) })`. The rules are the ones above, shared
with the full server. There is no logger and no request timeout on the compact server, so a fault is
the plain `500` and the handler bounds its own I/O. An app that does not import `notFound` ships
none of it.
