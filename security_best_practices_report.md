# Nifra security, correctness, and performance pass — remediated

Date: 2026-08-20
Scope: production sources under `packages/*/src`, with focused review of core request handling,
Node serving/static files, proxying, auth/session stores, SSR/head rendering, image processing,
uploads, caches, WebSockets, agent subprocess execution, and MCP/database boundaries.

## Executive summary

No critical vulnerability or known vulnerable dependency was found. Nifra's high-risk HTTP surfaces
are generally defensive: request bodies are bounded even when `Content-Length` lies, SSR script data
is breakout-escaped, Node static serving uses realpath containment plus `O_NOFOLLOW`, proxy redirects
and hop-by-hop headers are refused, session cookies are strongly signed, CSRF checks fail closed, and
MCP database execution is authorization- and result-bounded.

The pass found **ten actionable issues**, all remediated in this change set:

- **5 medium:** an invalid image ETag/cache contract, a local-image TOCTOU read, an unbounded default
  memory cache, image work that survives client disconnects, and untrusted Host forwarding.
- **5 low:** stale dynamic head metadata under object reuse, invalid upload limits being accepted,
  missing image-option validation, an abort-listener leak in local process execution, and short
  Cloudflare KV session TTL incompatibility.

The most valuable next feature remains a public image-result cache seam. Content-derived ETags now
make revalidation correct; an output cache would restore cheap conditional hits and avoid repeated
fetch/decode/transform work. Per the public/private rubric, Nifra should publish the interface plus
bounded in-memory/no-op reference implementations; durable, credentialed, tenant-aware operated
implementations belong in the private platform.

## Prioritized findings

### 1. Fixed (medium) — image responses used a false strong validator and could stay stale indefinitely

**Category:** correctness / cache integrity / performance
**Remediated in:** `packages/image/src/server.ts:256`, with regression coverage at
`packages/image/test/server.test.ts:502`.

**Remediation:** the handler now hashes the emitted representation with SHA-256, defaults to a
mutable-safe one-hour `max-age`, and emits `immutable` only through an explicit option for
content-versioned URLs. Without an output cache, conditional requests deliberately rerun the transform
before returning `304` so mutable sources cannot be falsely validated.

`createImageHandler` derives its ETag only from `src`, requested width, quality, and WebP negotiation.
It checks `If-None-Match` before reading the source. A local file or remote object can change at the
same URL while those request parameters remain identical, yet Nifra returns `304 Not Modified`.
The default response also says `Cache-Control: public, max-age=31536000, immutable`, so a browser or
CDN can retain the obsolete image for a year and will still receive a false 304 when it eventually
revalidates.

The audit reproduced this with a remote-source test double: after the source bytes changed, a
conditional request returned 304 and the source fetch count remained one. The documentation currently
calls this a “strong ETag,” which is not true for the representation.

**Fix:** An ETag must represent the emitted bytes (as `ogImageResponse` already does), or a versioned
source validator must participate in it. To keep conditional hits cheap, add an output cache keyed by
the transform request; cache `{ bytes, contentType, etag }`, and only short-circuit a conditional
request when that cached representation is still valid. Do not emit `immutable` unless source URLs
are explicitly required to be content-versioned.

**Mitigation now:** set a short `cacheMaxAge`, version image source URLs on every content change, and
do not rely on the current ETag for mutable URLs.

### 2. Fixed (medium) — local image containment and size checks were TOCTOU-vulnerable

**Category:** security / availability
**Remediated in:** `packages/image/src/server.ts:348-404`.

**Remediation:** the verified real path is opened once with `O_RDONLY | O_NOFOLLOW`; type and size are
checked on the descriptor; reads are bounded to the descriptor size; and the descriptor is always
closed. The original unverified pathname is never reopened.

The local image path is `stat`ed, size-checked, and `realpath`-checked, but the verified real path is
discarded. The later `readFile(resolved)` reopens the original pathname. A process able to mutate the
configured source tree can swap a symlink between verification and the read, causing an outside-root
file to be read. A file can also grow after `stat`, so `readFile` can allocate beyond
`maxSourceBytes`.

This is deployment-dependent: a read-only build asset directory is difficult to exploit, while an
upload-writable image root makes the race meaningful.

**Fix:** resolve containment, open the verified real path once with `O_RDONLY | O_NOFOLLOW`, `fstat`
the descriptor, then perform a bounded descriptor read. Never reopen the unverified pathname. The
Node static-file implementation already demonstrates the required ordering.

**Mitigation now:** keep `root` read-only to the application and separate it from all user-writable
upload directories.

### 3. Fixed (medium) — the default memory cache was unbounded and retained cold expired keys

**Category:** availability / memory growth
**Remediated in:** `packages/cache/src/memory-cache.ts:32-55` and
`packages/cache/src/memory-cache.ts:112-130`, with regression coverage at
`packages/cache/test/memory-cache.test.ts:36`.

**Remediation:** `MemoryCache` now defaults to a 10,000-entry LRU cap, reserves `maxEntries: 0` for
an explicit unbounded opt-in, and incrementally sweeps a fixed batch of expired cold entries on writes.

`createCache()` silently creates `new MemoryCache({ now })`. `MemoryCache` defaults
`maxEntries` to zero, meaning unbounded, and expired rows are removed only when that exact key is read.
High-cardinality keys—especially the documented `user:${params.id}` pattern—can therefore retain
expired values and tag-index entries indefinitely. An attacker who can vary a cache-key input can turn
this into process-memory exhaustion.

The audit reproduced the retention directly: 1,000 expired 1 KiB rows remained counted until their
individual keys were read.

**Fix:** make the reference store bounded by default, allow an explicit `Infinity`/`unbounded: true`
escape hatch, and opportunistically sweep a small fixed number of expired LRU entries on writes.
Consider the same production guard already used by `MemorySessionStore` and `MemoryCacheStore`.

**Mitigation now:** always pass `store: new MemoryCache({ maxEntries: ... })` or a bounded shared
store, and never derive cache keys from unbounded user input without normalization/rate limiting.

### 4. Fixed (medium) — abandoned image requests retained queue slots and expensive work

**Category:** performance / availability
**Remediated in:** `packages/image/src/server.ts:222-275`, `packages/image/src/server.ts:310-345`, and
`packages/image/src/server.ts:486-536`, with cancellation coverage at
`packages/image/test/server.test.ts:360` and `packages/image/test/server.test.ts:563`.

**Remediation:** admission and codec queues now remove aborted waiters; remote fetches combine request
cancellation with the configured timeout; local descriptor reads observe cancellation; and the handler
checks cancellation before and after codec work while releasing every acquired slot exactly once.

The handler never observes `req.signal`. A disconnected request remains in the admission semaphore,
eventually fetches/reads the source, waits for the codec, and transforms it. Active remote fetches use
only `AbortSignal.timeout(fetchTimeoutMs)`, not client cancellation. Repeated abandoned requests can
keep the bounded queue, network lanes, source buffers, and native codec busy doing work for clients
that no longer exist.

**Fix:** make semaphore acquisition abort-aware and remove cancelled waiters; combine request abort
with the fetch timeout; check cancellation before source read, codec admission, probe, and transform.
Ensure every acquired slot is released exactly once.

**Mitigation now:** keep `sourceConcurrency` and `maxQueue` conservative, require signed image URLs on
public endpoints, and enforce upstream/proxy request limits.

### 5. Fixed (medium) — proxy opt-in forwarded an attacker-controlled Host as trusted metadata

**Category:** security hardening / deployment-dependent
**Remediated in:** `packages/proxy/src/index.ts:142`, `packages/proxy/src/index.ts:287`, and
`packages/proxy/src/index.ts:738-756`, with regression coverage at
`packages/proxy/test/proxy.test.ts:183` and in the Node transport suite.

**Remediation:** inbound forwarding metadata remains stripped. `forwardClientIp` no longer emits a
forwarded host; `X-Forwarded-Host` can only come from the new fixed, validated `forwardedHost` option.

With `forwardClientIp: true`, the proxy correctly strips inbound forwarding headers, but rebuilds
`X-Forwarded-Host` from the raw inbound `Host`. Unless the outer server has an allowlist or canonical
host, that value is attacker-controlled. Upstreams frequently trust `X-Forwarded-Host` for absolute
links, password-reset URLs, tenant selection, or security redirects, creating a Host-header poisoning
path.

**Fix:** separate client-IP forwarding from forwarded-host emission. Require an explicit canonical
host or a distinct `forwardHost: true` opt-in, and document that the source Host must already have
passed an allowlist. Prefer the canonical public authority over raw input.

**Mitigation now:** configure `@nifrajs/node` with `allowedHosts` and `canonicalHost`, or override the
forwarded host with a fixed trusted header before requests reach the upstream.

### 6. Fixed (low) — object-identity head caching could leak stale dynamic metadata across requests

**Category:** correctness / privacy
**Remediated in:** `packages/web/src/internal/head-merge.ts:24-42` and
`packages/web/src/internal/render-document.ts:961-1029`, with regression coverage at
`packages/web/test/render.test.ts:719`.

**Remediation:** serialization is memoized only for objects observed as static meta exports. Results
from function-form meta bypass the identity cache even when the function reuses one mutable object.

`headTagsCache` memoizes every resolved `Meta` object by identity. The implementation assumes a
function-form `meta(args)` always allocates a fresh object, but the API does not enforce this. A meta
function that reuses and mutates one object serves the first serialized meta/link/JSON-LD/unsafe-script
set to later requests. Request- or user-specific metadata can therefore bleed between responses.

The audit reproduced this: after mutating a reused description from `first` to `second`, the second
render still contained `first` and not `second`.

**Fix:** only identity-cache values known to originate from static object exports. Thread an explicit
cacheability bit through `resolveMeta`/`mergeHeads`, or bypass `headTagsCache` for all function-form
meta results. Freezing/documenting dynamic return values is useful but not a sufficient runtime fix.

### 7. Fixed (low) — `validateUpload` accepted non-finite size limits

**Category:** security footgun / validation bug
**Remediated in:** `packages/uploads/src/validate.ts:32-35`, with regression coverage at
`packages/uploads/test/uploads.test.ts:60`.

**Remediation:** `maxBytes` must now be a non-negative safe integer; NaN, infinity, negative, and
fractional values fail before the input is inspected.

`maxBytes` is never validated. With `NaN`, both `input.size > maxBytes` and
`bytes.byteLength > maxBytes` are false, so recognized uploads of any size pass this validator.
`Infinity` disables the cap, and negative values have inconsistent behavior. The audit reproduced an
accepted PNG with `maxBytes: NaN`.

**Fix:** reject any value that is not a non-negative (preferably positive) safe integer before touching
the input. Keep the documentation's important requirement to pair this validator with
`c.boundedBody(maxBytes)`, which bounds allocation before validation.

### 8. Fixed (low) — several image handler limits accepted NaN, infinity, or negative values

**Category:** correctness / configuration validation
**Remediated in:** `packages/image/src/server.ts:130-160`, with construction-time regression coverage
in `packages/image/test/server.test.ts`.

**Remediation:** `maxWidth`, `cacheMaxAge`, `defaultQuality`, `fetchTimeoutMs`, and `immutable` are now
validated with explicit integer/range/type contracts alongside the existing image limits.

`maxSourceBytes`, `maxSourcePixels`, concurrency, and queue sizes are checked at construction, but
`maxWidth`, `cacheMaxAge`, `defaultQuality`, and `fetchTimeoutMs` are not. The audit confirmed that
`NaN`, `Infinity`, and negative values are accepted. They later produce invalid transform arguments,
invalid cache headers, or request-time fetch failures instead of a clear construction error.

**Fix:** validate all configuration together in `resolveConfig`: positive safe-integer `maxWidth`,
quality in 1-100, non-negative safe-integer `cacheMaxAge`, and positive safe-integer timeout (or a
documented zero-means-disabled convention).

### 9. Fixed (low) — successful local subprocess runs retained abort listeners

**Category:** performance / resource leak
**Remediated in:** `packages/agent/src/execution-policy.ts:202-229`, with listener-count regression
coverage at `packages/agent/test/execution-policy.test.ts:100`.

**Remediation:** a shared settle cleanup now removes the abort listener and clears both timers on
normal close and child error; the abort registration race is also closed.

Each run adds a once-only abort listener, but normal close and child-error paths never remove it. When
a long-lived `AbortSignal` is reused, completed runs retain child-process closures until that signal
eventually aborts or is collected. The audit ran 12 successful commands with one signal and observed
12 remaining abort listeners.

**Fix:** remove the listener in a shared settle/cleanup function on both `error` and `close`. Preserve
the current once-only listener for the actual abort path. Add a regression test similar to the proxy
package's listener-retention test.

### 10. Fixed (low) — short sessions were incompatible with Cloudflare KV expiration rules

**Category:** integration correctness
**Remediated in:** `packages/auth/src/store.ts:140-143`, with regression coverage at
`packages/auth/test/store.test.ts:86`.

**Remediation:** only the KV garbage-collection expiration is clamped to Cloudflare's 60-second
platform floor. The serialized authoritative `expiresAt` is unchanged, so session validity does not
outlive the configured lifetime.

The session API accepts `maxAge: 0` and other lifetimes under 60 seconds. `KVSessionStore` always
sends the corresponding absolute `expiration`, while Cloudflare KV requires an absolute expiration to
be at least 60 seconds in the future. The code comment acknowledges the platform floor but relies on
“realistic” configuration, so a valid Nifra configuration can fail only at commit time in production.

**Fix:** make the KV store omit the platform expiration for sub-60-second records (the session manager
still authoritatively checks `expiresAt`), clamp only the GC backstop to the platform minimum, or expose
a store capability/validation hook that lets `createSessions` reject incompatible lifetimes early.

## Public feature opportunities

These recommendations follow the repository's public/private rubric: publish moat-neutral contracts
and small local implementations; keep operated scale, credentials, tenancy, durability, policy, and
cross-customer intelligence private.

1. **Image result-cache interface.** Public: `ImageTransformCache` with `get/set/delete`, content ETags,
   a no-op adapter, and a bounded in-memory LRU. Private: CDN/Redis/R2/KV adapters, tenant quotas,
   purge orchestration, observability, and global invalidation. This complements the correctness fix
   for finding 1 by removing repeat fetch/decode/transform work.

2. **Shared `TrustedHtml` / `SanitizedHtml` brand.** React, Preact, Vue, Solid, and Svelte `Content`
   helpers currently accept plain strings at their raw-HTML sinks (for example
   `packages/web-react/src/content.ts:16-26`), while vanilla already makes raw output explicit via
   `RawHtml` (`packages/web-vanilla/src/html.ts:11-25`). Public: one framework-neutral brand and
   explicit `trustHtml`/escape constructors, consumed by every adapter. Private/optional: policy-bound
   sanitizer services and tenant-specific allowlists.

3. **Abort-aware admission primitive.** Public: a tiny `AdmissionQueue`/semaphore with bounded waiters,
   `AbortSignal` removal, timeout composition, metrics snapshots, and an in-memory implementation.
   Reuse it in image transforms and other CPU-heavy framework handlers. Private: distributed quotas,
   tenant fairness, adaptive shedding, and fleet-wide control.

4. **Safer `nifra check` advisories.** Add warnings for an unbounded default `MemoryCache`, a Node
   server with neither `allowedHosts` nor `canonicalHost` when origin-sensitive metadata is used,
   raw strings flowing into `Content` sinks once the brand exists, and a remotely exposed unsigned
   self-hosted image handler. These are static advisories, not claims of exploitability.

5. **Static-file conditional and range responses.** `@nifrajs/node` safely streams files and knows the
   descriptor's size/mtime, but currently emits the full file for every GET
   (`packages/node/src/index.ts:923-949`). Public support for `Last-Modified`/ETag, `If-Modified-Since`,
   single byte ranges, `If-Range`, and 416 responses would materially improve large media/download
   performance. This remains a local protocol feature; operated CDN delivery stays private.

6. **Cache safety/observability defaults.** Give in-memory caches a finite default, production guard,
   lightweight size/eviction counters, and an incremental expiry sweep. Rich multi-tenant dashboards,
   remote stores, and automated capacity policy stay private.

## Positive security observations

- Core body readers cap both declared and streamed/chunked bodies and do not trust `Content-Length`.
- SSR loader data and head script content escape HTML parser breakouts; executable inline scripts
  require a nonce and a narrow type allowlist.
- Head attributes reject event handlers, meta refresh, and active/local URL schemes.
- Node static serving denies dotfiles and traversal, resolves symlinks, opens the verified real path
  with `O_NOFOLLOW`, streams with backpressure, and closes descriptors on abandonment.
- Proxy upstream origins are fixed at construction; redirects, hop-by-hop headers, connection-named
  headers, forged forwarding metadata, and body/header stalls are handled defensively.
- Session IDs use strong randomness; cookies use HMAC with a 256-bit secret floor; verification is
  constant-time; HttpOnly is mandatory; reads fail closed; regeneration addresses fixation.
- CSRF and WebSocket same-origin checks default closed for browser credential-bearing requests.
- MCP database execution defaults to schema-only, requires authorization for queries, uses read-only
  SQLite mode/plan checks, and bounds results and worker time.
- The local subprocess adapter clearly states that it is not a security boundary and limits inherited
  environment names, execution time, and captured output.

## Verification performed

- Release-equivalent gate: `bun run check:release` passed build, lint, typecheck, tests, CLI
  isolation, coverage, corpora/docs, public boundaries/manifests, size and performance budgets,
  publish/consumer checks, cold start, Deno/Node/workerd parity, pipeline/verification parity, and
  changeset coverage.
- Affected-package runtime tests: **1,219 passed, 0 failed** across image, proxy, web, uploads, agent,
  auth, and cache; the repository coverage run passed **4,553 tests** with the ratchet clean; the full
  Node transport suite also passed.
- TypeScript: `bun run typecheck` passed across **11 projects**.
- Core performance gate: passed; median **570 ns/op** for `GET /` and **639 ns/op** for
  `GET /users/:id` (10,000 ns/op budget).
- Dependencies: `bun audit` reported **No vulnerabilities found**.
- Focused regression coverage exercises all ten remediated findings.

## Remediation status

All ten numbered findings are fixed with focused regression coverage. The six public feature
opportunities are intentionally retained as roadmap candidates; they are additive product work, not
required mitigations for the closed findings.
