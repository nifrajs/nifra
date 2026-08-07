# @nifrajs/deno

## 2.9.0

### Patch Changes

- 5f7fb33: Stop reading the `Upgrade` header on every request. The adapter used that read as a pre-filter
  before consulting the WebSocket seam, on the assumption it was cheaper than resolving an upgrade -
  but the seam already answers "not an upgrade" on an app with no `ws()` routes by checking its own
  route count, without touching headers at all. So the probe skipped nothing and instead forced the
  runtime to materialize the request's header list for every plain HTTP request, including routes
  that never read a header. Deno bills header access lazily, so that cost landed on requests which
  would otherwise have paid nothing: measured at ~7% of throughput on a bare JSON route under Deno
  2.9, ~4.5% under 2.8.

  The seam is now bound once when the server starts and called directly, and the settled-outcome
  handling moved out of the per-request closure so the common plain-HTTP path allocates nothing. On a
  bare `GET` the adapter measures ~11% faster and now runs within a few percent of a hand-written
  `Deno.serve` handler. Upgrade behavior is unchanged - a handshake still upgrades, an `upgrade()`
  guard's rejection is still returned as an HTTP response, and a non-nifra `{ fetch }` handler still
  skips the seam entirely - and the package gains its first WebSocket round-trip tests covering
  exactly those paths.

## 2.8.2

## 2.8.1

## 2.8.0

## 2.7.1

## 2.7.0

## 2.6.1

## 2.6.0

## 2.5.0

## 2.4.0

## 2.3.0

## 2.2.0

## 2.1.0

## 2.0.0

### Minor Changes

- a7b1d60: Add `c.clientIp` - the caller's IP, derived correctly and vendor-neutrally.

  By default it is the raw socket peer the serving adapter observed (`listen()`, `@nifrajs/node`, `@nifrajs/deno` supply it; any caller can pass it via `app.fetch(req, { clientIp })`), the one address a client cannot forge - and never a forwarded header. Behind a reverse proxy or CDN, set the `clientIp` server option to derive the real caller from the forwarding chain as far as you trust it:

  - `server({ clientIp: { trustedHops: n } })` reads `X-Forwarded-For` past `n` proxies you operate (a short header fails closed to `undefined`);
  - `server({ clientIp: { header: "x-real-ip" } })` trusts one edge-set header's first value.

  Declaring trust the app can't enforce would let clients forge their IP, so it stays unset by default. `c.clientIp` is safe to key rate limits and audit logs on, and is resolved once before handlers, `derive`, and hooks run.

### Patch Changes

- ade0c7a: Add a curated `@nifrajs/core/server` entry for the common HTTP runtime and dedicated subpaths for
  contracts, classification, cookies, logging, routing, Standard Schema, SEO, SSE, and webhooks. The
  package root remains backwards compatible, while new scaffolds and first-party runtime packages avoid
  eagerly parsing opt-in causality, invariant, manifest, reflection, capability, and assurance tooling.

## 1.13.0

## 1.12.0

## 1.11.0

## 1.10.0

## 1.9.1

## 1.9.0

## 1.8.0

## 1.7.0

## 1.6.0

## 1.5.0

## 1.4.0

## 1.3.1

## 1.3.0

## 1.2.2

## 1.2.1

## 1.2.0

## 1.1.0

## 1.0.0

## 1.0.0-beta.4

## 1.0.0-beta.3

## 0.1.0-beta.2
