# @nifrajs/middleware

## 2.0.0

### Major Changes

- d91a45b: Remove Nifra's remaining deprecated and compatibility-only public surfaces for the 2.0 cutover.

  - `@nifrajs/core` and `nifra` now expose only the lean HTTP server API at their package roots. Import
    optional systems from their documented subpaths. The deprecated invariant runner and the
    `@nifrajs/budget` compatibility package are removed; use `@nifrajs/testing` and
    `@nifrajs/core/budget` respectively.
  - Web redirects accept only an options object as their second argument, the prerender enumeration
    wrapper is removed in favor of `enumerateStaticRoutes()`, and fragment navigation resolves IDs only.
  - MCP Apps metadata uses only `_meta.ui.resourceUri`; the deprecated flat `ui/resourceUri` key is gone.
  - Telemetry uses `ObservationAdapter` directly; the `AgentSpan`, `AgentSpanExporter`, and `SpanExporter`
    aliases are removed.
  - Invalid HTTP method overrides always fail closed with 400; the legacy ignore mode is removed.
  - `nifra build` always emits a complete target deploy directory and defaults to Bun. The old
    client-only build branch is removed; `nifra start` runs the generated Bun `server.js`.

### Patch Changes

- ade0c7a: Add a curated `@nifrajs/core/server` entry for the common HTTP runtime and dedicated subpaths for
  contracts, classification, cookies, logging, routing, Standard Schema, SEO, SSE, and webhooks. The
  package root remains backwards compatible, while new scaffolds and first-party runtime packages avoid
  eagerly parsing opt-in causality, invariant, manifest, reflection, capability, and assurance tooling.
- Updated dependencies [a7b1d60]
- Updated dependencies [eaac3d7]
- Updated dependencies [ade0c7a]
- Updated dependencies [82676e0]
- Updated dependencies [1522d06]
- Updated dependencies [a7b1d60]
- Updated dependencies [a7b1d60]
  - @nifrajs/core@2.0.0
  - @nifrajs/schema@2.0.0

## 1.13.0

### Patch Changes

- @nifrajs/schema@1.13.0

## 1.12.0

### Patch Changes

- @nifrajs/schema@1.12.0

## 1.11.0

### Patch Changes

- 2dde7e5: Documentation polish for the adaptive-admission module.
  - @nifrajs/schema@1.11.0

## 1.10.0

### Patch Changes

- 92181be: Move request-deadline mechanics to the dependency-free `@nifrajs/core/budget` subpath while keeping
  `@nifrajs/budget` as a compatible re-export. Harden adaptive admission across ESM runtimes, reserved
  capacity, disconnected queued requests, and invalid capacity evidence.
  - @nifrajs/schema@1.10.0

## 1.9.1

### Patch Changes

- @nifrajs/schema@1.9.1

## 1.9.0

### Patch Changes

- @nifrajs/schema@1.9.0

## 1.8.0

### Minor Changes

- e47c4c5: Add reflection-time route assurance: middleware and plugins can publish lifecycle-accurate enforcement
  evidence, ordered policies fail closed on unclassified/missing/forbidden evidence, official hardening
  middleware emits canonical evidence, and `nifra assure` exposes a human/JSON CI gate.

### Patch Changes

- @nifrajs/schema@1.8.0

## 1.7.0

### Patch Changes

- @nifrajs/schema@1.7.0

## 1.6.0

### Patch Changes

- @nifrajs/schema@1.6.0

## 1.5.0

### Patch Changes

- Updated dependencies [bd3433f]
  - @nifrajs/schema@1.5.0

## 1.4.0

### Patch Changes

- Updated dependencies [4d25970]
  - @nifrajs/schema@1.4.0

## 1.3.1

### Patch Changes

- @nifrajs/schema@1.3.1

## 1.3.0

### Patch Changes

- Updated dependencies [4a4b1c4]
  - @nifrajs/schema@1.3.0

## 1.2.2

### Patch Changes

- @nifrajs/schema@1.2.2

## 1.2.1

### Patch Changes

- @nifrajs/schema@1.2.1

## 1.2.0

### Patch Changes

- @nifrajs/schema@1.2.0

## 1.1.0

### Patch Changes

- Updated dependencies [17e57c4]
  - @nifrajs/schema@1.1.0

## 1.0.0

### Minor Changes

- de9675b: Pre-1.0 security hardening pass. A framework-wide audit found no critical/high issues; these close the medium/low items it surfaced.

  - **`cache()` — no cross-user leak by default.** A `200` to a request bearing `Authorization`/`Cookie` is no longer stored (and replayed to other users) unless the response is explicitly `Cache-Control: public`/`s-maxage` (RFC 9111 §3.5). Opt back in per cache with `cacheAuthenticated: true` for a route that's identical for every caller.
  - **`idempotency()` — route-scoped keys + a `key` hook.** The default store key is now scoped by method+path, so the same `Idempotency-Key` on a different endpoint can't collide and replay another resource's response. Added a `key(req, header)` option to scope by principal (e.g. user id). Method matching normalized to upper-case.
  - **`etag()` — a `304` no longer carries the `200`'s `Content-Length`/`Content-Type`.**
  - **`@nifrajs/core` — inbound WebSocket frames are capped** when serving on Bun (`listen()`): frames over `wsMaxPayloadBytes` (default `maxBodyBytes`, 1 MB) are rejected by the runtime before reaching a handler, so a huge frame can't be buffered/parsed into memory. New `ServerOptions.wsMaxPayloadBytes`.
  - **`@nifrajs/core` — WebSocket routes are same-origin by default (CSWSH).** A `ws()` route with no `allowedOrigins` now rejects a **cross-origin browser** handshake (an `Origin` whose host differs from the request's) with `403` — closing cross-site WebSocket hijacking, since browsers send cookies on WS handshakes and don't apply CORS. Non-browser clients (no `Origin`) and same-origin browsers are unaffected. **Breaking** for a route that served a cross-origin browser without declaring `allowedOrigins`: set `allowedOrigins` to the permitted origins (or `() => true` for a genuinely public socket).
  - **`@nifrajs/node` — static file handler** now adds `X-Content-Type-Options: nosniff` and re-checks the real path (symlink containment) before streaming, matching the image server.
  - **`@nifrajs/mcp` — widget bridge** now rejects `postMessage` events whose source isn't the parent window (including null-source synthetic events), closing a spoofing gap the previous guard left open.
  - **`@nifrajs/cli` — the MCP `nifra_run`/`nifra_ws` `entry` arg** is kept inside the project root, so a crafted `entry` can't import/execute a module outside the project.

### Patch Changes

- Updated dependencies [f1f0e18]
- Updated dependencies [3efb7cd]
- Updated dependencies [de9675b]
  - @nifrajs/core@1.0.0
  - @nifrajs/schema@1.0.0

## 1.0.0-beta.4

### Patch Changes

- @nifrajs/core@1.0.0-beta.4
- @nifrajs/schema@1.0.0-beta.4

## 1.0.0-beta.3

### Patch Changes

- @nifrajs/core@1.0.0-beta.3
- @nifrajs/schema@1.0.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- @nifrajs/core@0.1.0-beta.2
- @nifrajs/schema@0.1.0-beta.2
