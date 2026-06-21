# @nifrajs/middleware

Composable, dependency-light middleware for [nifra](../../README.md) — CORS, security headers, body
limits, auth, CSRF, JWT/JWKS, IP restriction, response caching, timing, and ops helpers — applied with
`app.use()`.

```sh
bun add @nifrajs/middleware
```

```ts
import { server } from "@nifrajs/core"
import {
  bodyLimit,
  cors,
  MemoryStore,
  rateLimit,
  securityHeaders,
  timing,
} from "@nifrajs/middleware"

const app = server()
  .use(securityHeaders())
  .use(cors({ origin: ["https://app.example.com"], credentials: true }))
  .use(bodyLimit({ maxBytes: 1_000_000 }))
  .use(rateLimit({
    store: new MemoryStore(),
    max: 100,
    windowMs: 60_000,
    key: (req) => req.headers.get("x-user-id") ?? "anonymous",
  }))
  .use(timing())
  .get("/", () => ({ ok: true }))
```

- **`bodyLimit({ maxBytes })`** — fail-closed `Content-Length` gate before routing. Lengthless
  bodies are rejected with `411` by default; use route-level `c.boundedBody()` / schema validation
  for intentionally streamed endpoints.
- **`basicAuth(options)`** — Basic Auth plugin with constant-time static credential comparison or
  a custom verifier.
- **`bearer(options)` / `apiKey(options)`** — token auth plugins with typed principals.
- **`csrf({ secret })`** — signed double-submit CSRF protection plus Origin/Referer checking.
- **`jwt(options)` + `verifyJwt()` / `tryVerifyJwt()` + `jwk()` / `jwks()`** — JWT auth
  with explicit algorithm allowlists, required expiration by default, issuer/audience checks,
  direct JWK, HTTPS JWKS, and an additive no-throw Result helper for manual verification.
- **`ipRestriction(options)`** — allow/deny IPv4/IPv6 exact and CIDR matches. Fails closed unless
  you provide `clientIp`, trusted proxy extraction, or a trusted single-IP header.
- **`cors(options)`** — preflight handling + headers on *every* response (errors and
  404s included). Origin as `"*"` / exact / list / predicate. **Throws** if
  `credentials: true` is paired with `origin: "*"` (the browser rejects it).
- **`securityHeaders(options)`** — `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy` by default; opt-in HSTS and CSP.
- **`rateLimit(options)`** — `429` + `Retry-After` + `RateLimit-*` headers, with a
  pluggable `RateLimitStore`. Configure a trusted `key`, trusted single-IP `header`, or
  `trustedProxies`; a missing key source fails closed instead of silently sharing one
  bucket. The bundled `MemoryStore` **refuses to run in production** (a per-instance
  limiter is unsafe across instances) — provide a shared store (Redis, etc.) there.
- **`cache({ store, ttlMs })` / `responseCache(...)`** — full response cache with a pluggable
  store, `Vary`-aware keys, `Age`, byte caps, and `Cache-Control` / `Set-Cookie` safety defaults.
  `MemoryResponseCache` is dev/single-instance only unless explicitly allowed in production.
- **`timing()`** — `Server-Timing` plus typed `c.timing.metric/mark/measure` controls.
- **`prettyJson()`** — capped, JSON-only pretty printing for debugging and developer-facing APIs.
- **`methodOverride()`** — header/query method tunneling for clients that can only send `POST`.
  Header override is on by default; query override is opt-in.
- **`trimTrailingSlash()` / `appendTrailingSlash()`** — redirect or rewrite URL canonicalization.
- **`poweredBy()`** — opt-in product/framework header; Nifra emits no powered-by header by default.
- **`language()` / `pickLanguage()`** — `Accept-Language` negotiation with typed `c.language`.
- **`combine()` / `namedCombine()`** — reusable runtime bundles for middleware/plugins.
- **`requestId()` / `logger()` / `etag()` / `compression()` / `cacheControl()` /
  `idempotency()` / `healthcheck()` / `openapi()`** — additional operational middleware for APIs.

Request timeouts are configured at the core server boundary so they can abort `c.signal` and race the
whole lifecycle:

```ts
const app = server({ requestTimeoutMs: 5_000 })
```

`@nifrajs/core` is a peer dependency. ESM-only. MIT.

## For AI agents

Building on nifra with an AI coding agent? The repo's [`AGENTS.md`](../../AGENTS.md) is the copy-paste
quick reference, and [`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run
`nifra check` as the done-gate, or `nifra mcp` to give the agent live project tools.
