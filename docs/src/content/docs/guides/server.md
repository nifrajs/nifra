---
title: Server & routing
description: Routes, path params, the handler context, lifecycle hooks, and built-in hardening.
---

## Routes & params

```ts
import { server } from "@nifrajs/core"

const app = server()
  .get("/users/:id", (c) => ({ id: c.params.id }))                 // :param
  .get("/users/:id/posts/:postId", (c) => c.params)                // multiple
  .get("/files/*path", (c) => ({ path: c.params.path }))           // trailing wildcard
```

Param names are inferred from the path literal, so `c.params` is precisely typed.
Routing is a radix trie; a 404 (no path) and a 405 (wrong method, with an `Allow`
header) are distinguished.

## The handler context

A handler receives one `Context` and returns a value (serialized to JSON) or a
`Response` (used as-is):

- `c.params` — typed path params
- `c.query` — the validated query (or raw `URLSearchParams` with no query schema)
- `c.body` — the validated body (or `undefined` with no body schema)
- `c.req` — the raw `Request`
- `c.set` — `{ status, headers }` to influence the response
- `c.signal` — aborts on request timeout (for cancellation-aware work)

## Lifecycle & context extension

`derive` (per-request) and `decorate` (static) extend the **typed** context for routes
declared after them; lifecycle hooks run around handlers:

```ts
const app = server()
  .decorate("db", db)                              // c.db is typed everywhere below
  .derive((c) => ({ user: authenticate(c.req) }))  // c.user is typed
  .onRequest((req) => undefined)                   // before routing; return a Response to short-circuit
  .beforeHandle((c) => undefined)                  // non-undefined short-circuits the handler
  .afterHandle((result, c) => result)              // transform the result
  .onResponse((res) => res)                        // runs on EVERY response (incl. errors/404)
  .onError((err, c) => undefined)                  // map errors to a response
  .get("/me", (c) => c.user)
```

Apply a reusable bundle with `app.use(middleware)` — see
[Middleware & hardening](/guides/middleware/).

## Production hardening

```ts
const app = server({
  maxBodyBytes: 1_000_000,   // streaming cap — rejected before/at the limit
  requestTimeoutMs: 5_000,   // slow request → 503; c.signal aborts
  gracefulSignals: true,     // listen() installs SIGTERM/SIGINT → graceful stop
  logger: myLogger,          // default: a redacting JSON logger
})

// Stop accepting new connections, drain in-flight (up to drainMs), then force-close:
await app.stop({ drainMs: 10_000 })
```

Unhandled errors never crash the server or leak internals — the client gets a flat
`500`; the detail goes to the (redacting) logger.

## SEO: `sitemap.xml` & `robots.txt`

nifra ships pure, edge-safe builders for both — wire them to a route on any runtime:

```ts
import { robots, server, sitemap } from "@nifrajs/core"

const app = server()
  .get(
    "/sitemap.xml",
    () =>
      new Response(
        sitemap(
          [
            { url: "/", changefreq: "daily", priority: 1.0 },
            { url: "/blog", lastmod: new Date(), priority: 0.8 },
          ],
          { hostname: "https://example.com" }, // makes path-only urls absolute
        ),
        { headers: { "content-type": "application/xml; charset=utf-8" } },
      ),
  )
  .get(
    "/robots.txt",
    () =>
      new Response(
        robots({
          rules: [{ userAgent: "*", allow: ["/"], disallow: ["/admin"] }],
          sitemap: "https://example.com/sitemap.xml",
        }),
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      ),
  )
```

`sitemap()` XML-escapes every `<loc>` (DB-derived slugs can't inject markup), validates `priority`
(`0.0`–`1.0`) and `changefreq`, and enforces the 50,000-URL per-file limit. `robots()` flattens
newlines in any value, so a crawler directive can't be forged through a path. Both are synchronous and
allocation-light — fine to call per request, or once at build time for a static `sitemap.xml`.
