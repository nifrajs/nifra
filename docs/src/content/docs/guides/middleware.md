---
title: Middleware & hardening
description: Composable CORS, security headers, and rate limiting via app.use().
---

`@nifrajs/middleware` ships composable, dependency-free hardening you apply with
`app.use()`. Each is a bundle of lifecycle hooks; they attach to `onResponse` where
needed, so their headers land on **every** response — errors and 404s included.

```ts
import { server } from "@nifrajs/core"
import { cors, securityHeaders, rateLimit, MemoryStore } from "@nifrajs/middleware"

const app = server()
  .use(securityHeaders())
  .use(cors({ origin: ["https://app.example.com"], credentials: true }))
  .use(rateLimit({
    store: new MemoryStore(),
    max: 100,
    windowMs: 60_000,
    key: (req) => req.headers.get("x-user-id") ?? "anonymous",
  }))
  .get("/", () => ({ ok: true }))
```

## CORS

```ts
cors({
  origin: "*",                 // or an exact origin, a list, or (origin) => boolean
  credentials: false,          // `true` cannot be combined with origin "*" — it throws
  methods: ["GET", "POST"],
  allowedHeaders: ["content-type"],
  maxAge: 600,
})
```

Preflight (`OPTIONS`) is answered with `204`; `Access-Control-Allow-Origin` and friends
are added in `onResponse`. Pairing `credentials: true` with `origin: "*"` throws at
construction — the browser rejects that combination, so nifra fails loud.

## Security headers

```ts
securityHeaders({
  frameOptions: "DENY",                 // default
  referrerPolicy: "no-referrer",        // default
  hsts: { maxAge: 31_536_000, includeSubDomains: true }, // opt-in (HTTPS only)
  contentSecurityPolicy: "default-src 'self'",           // opt-in (app-specific)
})
```

`X-Content-Type-Options: nosniff`, `X-Frame-Options`, and `Referrer-Policy` are set by
default; HSTS and CSP are opt-in.

## Rate limiting

```ts
rateLimit({
  store: new MemoryStore(), // dev/single-instance only — see below
  max: 100,
  windowMs: 60_000,
  key: (req) => req.headers.get("x-user-id") ?? "anonymous",
})
```

Over the limit → `429` + `Retry-After`; every response carries
`RateLimit-Limit/Remaining/Reset`. Implement `RateLimitStore` for a shared backend
(Redis, etc.).

:::caution[MemoryStore is per-instance]
`MemoryStore` **throws in `NODE_ENV=production`** unless you pass
`{ allowInProduction: true }` — a per-instance limiter is unsafe across multiple
instances. In production, use a shared store.
:::

A `Middleware` can't see the socket IP (that needs the server instance), so configure an
explicit `key`, a trusted single-IP `header`, or `trustedProxies` for proxy-appended
`X-Forwarded-For`. A missing key source fails closed; use `allowGlobalKey: true` only
for an intentional shared throttle.
