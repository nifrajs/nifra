# @nifrajs/deno

## 5.9.0

### Minor Changes

- 9c20e05: `@nifrajs/node`'s and `@nifrajs/deno`'s `serve` take `gracefulSignals` in place of `signals`, the name Bun's `server({ gracefulSignals })` already uses. The value is unchanged: `true`, or the `{ drainMs, delayMs }` passed to `stop()`.
  
  ```ts
  // before
  await serve(app, { port: 3000, signals: { drainMs: 8_000 } })
  // after
  await serve(app, { port: 3000, gracefulSignals: { drainMs: 8_000 } })
  ```
  
  A `signals` option is refused with a `TypeError` that names `gracefulSignals`, so a server cannot start without the signal handling it asked for. `nifra build --target node` and `--target deno` emit `gracefulSignals`.
- fa7d102: `@nifrajs/deno`'s `serve` takes `static`, a handler that sees every request before the app does. It answers with a response, or hands the request to the app with `undefined`. A file it answers wins over any route at the same path, no hook of the app runs for it, and a throw answers a plain `500`.
  
  `nifra build --target deno` emits a server that runs on `@nifrajs/deno`'s `serve` and serves its client bundle and public files through `static`, so a Deno app installs `@nifrajs/deno` of the same release, as a Node app installs `@nifrajs/node`. The built server serves WebSocket routes, and `stop()` drains its in-flight requests. With an older adapter installed the build stops before bundling and names both versions.
  
  A built Deno server serves its static files again. Bun's browser stand-in for `node:crypto`, which the Deno entry tags files with, has no working `createHash`, so every file answered `404` and pages loaded without their client bundle. The Deno server bundle now imports `node:crypto` from Deno itself, and a `--vite` Deno build no longer refuses it as an edge built-in. `buildServer` and `buildServerVite` take `providedBuiltins`, the Node built-ins the runtime that runs the bundle has besides what its target implies.
  
  `nifra.config.ts` takes `selfHost`, the settings the server a `bun`, `node` or `deno` build emits starts with, `nifra start` included. `gracefulSignals` (`true`, or `{ drainMs, delayMs }`) drains the server on SIGTERM and SIGINT instead of letting the signal kill it. `idleTimeoutSec` is how long a Bun server keeps a connection that moves no bytes, from `0` (never) to 255; Node and Deno ignore it, and an edge build ignores `selfHost`. `buildTarget` and `generateServerEntry` take the same `selfHost` and refuse a value of the wrong shape before building.
- c4ed3e9: `serveStatic(mounts)` serves files on disk with one set of options on every runtime: from `@nifrajs/core/serve-static` for Bun's `app.listen({ static })`, and from `@nifrajs/node` and `@nifrajs/deno` for their `serve({ static })`. Each reads files with its runtime's own file API, and a mount answers a request the same way on all three.
  
  ```ts
  import { ONE_DAY, serveStatic } from "@nifrajs/core/serve-static"
  
  app.listen(3000, {
    static: serveStatic([
      { dir: new URL("./dist/assets/", import.meta.url), hashedFiles: build.assets, cacheControl: ONE_DAY },
      { dir: new URL("./public/", import.meta.url), prefix: "/", immutable: false, cacheControl: ONE_DAY, fallthrough: true },
    ]),
  })
  ```
  
  A mount takes `dir`, `prefix` (default `/assets`), `immutable`, `hashedFiles`, `cacheControl`, `files`, `allow`, `headers`, `dotfiles` and `fallthrough`. `hashedFiles` takes paths, an array of RegExps or a `(pathname) => boolean` predicate, matched on the encoded URL path, so files a pre-build step content-hashed, such as the fonts `loadGoogleFont` writes into `public/fonts/`, are cached immutably without being in the build manifest. A global or sticky pattern is used without that flag; a predicate runs as written. A path under a mount's prefix that it cannot serve answers `404` (`400` malformed, `403` traversing) unless the mount sets `fallthrough: true`, which hands it to the next mount and then the app. A request no mount takes returns `undefined` synchronously.
  
  `@nifrajs/web`'s `servePublicDir`, `ServePublicDirOptions`, `PublicDirCache` and `HashedFiles` are removed. `servePublicDir({ dir })` answers as `serveStatic({ dir, prefix: "/", fallthrough: true, hashedFiles: (path) => path.startsWith("/assets/"), cacheControl: ONE_DAY })` does, and `nifra upgrade 5.9.0` makes that edit. `nifra dev` serves `public/` with it, and the servers `nifra build` emits for bun, node and deno pass their runtime's `serveStatic` the same mounts.

### Patch Changes

- 123409c: `@nifrajs/node` and `@nifrajs/deno` read core's WebSocket upgrade outcome through one generated type view, which core checks its own types against, instead of two hand-written mirrors.
  
  The CLI's MCP workers share one request reader, its project children one stdout guard, six `nifra check` security scans one file walker, and its route-text scans one string-aware scanner.
  
  The Bun and Vite builds of `@nifrajs/web` share their client-entry, manifest and server-build steps, and the Vite client leak guard and server zone guard share one plugin body. `bunBundler.buildServer` and `viteBundler.buildServer` pass every option they receive through to `buildServer` and `buildServerVite`, so an option the `Bundler` type leaves out, such as `conditions`, `minify` or `lazy`, takes effect instead of being dropped.
  
  Core's evidence, diff and saga code share their schema-part mapping and saga ownership steps, its SQL and Durable Object lease stores share their row mapping and held-lease update, and the JSON body lane's byte readers share one settle step.
  
  `@nifrajs/node`'s two request sources share one base for their URL and header reads, and its Web-request fallback and Request/Response forwarding each live once.
  
  The coding agent's dispatch store checks a lease once for every write, its host and tracer share one plan index and gate check, and its two UI extension calls share one handler.
  
  `@nifrajs/agent` checks a tool step's deadline through one helper before and after approval, and its fake and replay gateways validate their scripted responses once. `@nifrajs/testing`'s agent-eval composition records its contract-lab and certification components through one helper.
  
  `@nifrajs/schema` reads one record guard from a single module.
- bc42fd2: `ws.close()` on Deno counts a lone surrogate in the reason as the three bytes of U+FFFD it is sent as, as Bun and Node do. A reason over 123 bytes that way now throws the same `RangeError` before the socket is touched; it used to reach Deno's `WebSocket.close`, which threw a `SyntaxError`.
- 9942748: A partially prerendered hole ignores a fill that is an array, as it ignores any other fill that is not an object, so an interactive hole's root never renders one as its props.
  
  `@nifrajs/node` merges a plain render's headers and checks a WebSocket close through generated copies of `@nifrajs/core`'s own functions, which `check:vendored` keeps identical to their source.
  
  A WebSocket text message or close reason whose length alone cannot settle its byte cap is sized by the runtime's native `Buffer.byteLength` where a global `Buffer` exists (Bun, Node, Deno, and Workers on a recent compatibility date), and counted character by character where it does not.
  
  `nifra stylex-migrate` reads nested style objects through the CLI's shared record check.

## 5.8.0

No changes in this release.

## 5.7.0

### Minor Changes

- b141cf4: A stop now tells the load balancer before it drains. `app.onStopping(fn)` runs as `stop()` begins,
  before in-flight requests drain, and `stop({ delayMs })` (or `gracefulSignals: { delayMs }`, and
  `signals: { delayMs }` on the Node and Deno adapters) keeps serving that long first, so a balancer
  polling readiness takes the instance out of rotation while it still answers. `onStop` hooks run after
  the drain as before, on Node and Deno too.
  
  `healthcheck()` readiness is reworked for production probes:
  
  - `/ready` answers `503 { status: "stopping" }` from the moment a stop begins, without running a
    check.
  - Each check gets an `AbortSignal` and a timeout (`timeoutMs`, default 2 s, settable per check), and
    reports `timeout` past it.
  - A check is never called again while an earlier call still runs, probes arriving during a run share
    it, and a finished run answers probes for `cacheMs` (default 1 s).
  - A check marked `optional: true` reports `degraded` and keeps `/ready` at `200`.
  - A check moving between passing and failing is logged once each way (`logger`, default
    `jsonLogger()`).
  
  The `/ready` body changes shape: each check is now `{ status: "pass" | "fail" | "timeout", ms }`
  (plus `optional: true`) where it was a boolean, and the top-level `status` can also be `degraded` or
  `stopping`. A monitor that reads the body rather than the status code needs updating.
  
  `nifra doctor` counts an `onStopping` hook as graceful-shutdown handling.

## 5.6.0

### Patch Changes

- bb35ad0: `ws.close(code, reason)` with a close RFC 6455 forbids - a code outside 1000-1003, 1007-1014 and
  3000-4999, a reason over 123 UTF-8 bytes, or a reason without a code - throws a `RangeError` on every
  runtime, and the socket stays open. Bun and Deno sent such a close on the wire; on Node, `ws` threw
  after marking the socket closing, so its later sends were dropped and the client's close was never
  answered; Workers threw their own error.
- c7d233d: `ws.close()` with no code sends 1000 on every runtime, and the `close` callback hears 1000. Bun sent
  1000 already; Node, Deno and Workers sent a close with no status, which the peer reads as 1005.
- feff82f: A WebSocket route's `close` callback is given the server's own code and reason when the server closed
  first - `ws.close(code, reason)`, or 1009 "message too large" for a message over the payload cap - on
  every runtime, as on Bun. Node, Deno and Workers passed on the peer's echo of the close, which
  usually drops the reason, and Node reported 1006 when `ws` refused a message over its cap.

## 5.5.1

No changes in this release.

## 5.5.0

No changes in this release.

## 5.4.0

No changes in this release.

## 5.3.0

No changes in this release.

## 5.2.1

No changes in this release.

## 5.2.0

### Patch Changes

- 9498cf8: The package ships its `CHANGELOG.md`, so the installed package has the notes for every version, as the GitHub release does. Before, the tarball held only the code, `README.md`, `LICENSE` and `package.json`.

## 5.1.0

### Patch Changes

- 5ab361c: Checking `wsMaxPayloadBytes` on Deno, and on runtimes wired through `attachWebSocket` (Cloudflare Workers), no longer UTF-8 encodes every text message to measure it: the size is counted in place, and a message whose length alone settles the answer is not scanned at all. Before, each capped text message was copied once just to be measured. The `@nifrajs/deno` docs now state the limit of that check: `Deno.upgradeWebSocket` takes no size limit, so Deno receives each message whole (up to its own 64 MiB on Deno 2.9) before the cap closes the socket with `1009`.
- 7c8b345: A WebSocket route with `validateSend: true` now checks its outbound frames against `sendSchema` on Node and Deno too, as it already did on Bun: a frame the schema refuses is dropped before it reaches the client and reported to the route's `error()`. Before, `@nifrajs/node` and `@nifrajs/deno` sent every frame unchecked. The upgrade outcome a nifra app hands an adapter now carries a `sender` that adapters wiring their own sockets build `ws.send` with.

## 5.0.0

### Patch Changes

- 558f92a: `stop({ drainMs })` counts a request as in flight until its whole response body is sent. A streamed response still running at the deadline is force-closed; before, the handler returning was enough to count as drained, and `stop()` then waited on the stream with no deadline.
- 077657f: `server({ gracefulSignals: { drainMs } })`, and `serve(app, { signals: { drainMs } })` on Node and Deno, set how long in-flight requests get to finish when SIGTERM or SIGINT stops the server before the stop forces them closed. `true` keeps the 10 second default. `nifra doctor` counts the object form as a graceful lifecycle.

## 4.0.2

## 4.0.1

## 4.0.0

### Minor Changes

- 10bc446: feat(core): `tls` serves HTTPS straight from the process, on Bun, Node and Deno.

  ```ts
  import { readFileSync } from "node:fs";

  const tls = { cert: readFileSync("cert.pem"), key: readFileSync("key.pem") };

  app.listen(443, { tls }); // Bun
  await serve(app, { port: 443, tls }); // @nifrajs/node or @nifrajs/deno
  ```

  `cert` and `key` are PEM, as text or the files' bytes. Requests then arrive with `https:` URLs, and
  WebSocket upgrades use the same port. Bun also takes `passphrase` for an encrypted key. On Node,
  `tls` accepts any `node:tls` server option (`ca` and `requestCert` for client certificates,
  `minVersion`, `SNICallback`), and the request protocol defaults to `https` when it is set. Without
  `tls`, each runtime serves plain HTTP, which is what a proxy or platform that ends TLS expects.

## 3.5.0

### Patch Changes

- d5b7c22: Harden request boundaries, error handling, resource limits, signing, and cross-runtime adapters for safer production releases.

## 3.4.0

## 3.3.0

## 3.2.0

### Patch Changes

- f061feb: Make Deno server shutdown drain active handlers safely across Deno runtime releases and force-close requests that exceed the configured deadline without triggering a `BadResource` race.

## 3.1.0

## 3.0.0

## 2.14.1

## 2.14.0

## 2.13.0

## 2.12.1

## 2.12.0

### Patch Changes

- f8b0097: A `.ws()` route's `maxPayloadBytes` is now enforced on every runtime, not only the ones whose socket
  implementation happened to police it. The declared cap travels with the upgrade outcome, so the Node
  bridge hands it to `ws` as `maxPayload`, and the Deno and Workers/`attachWebSocket` message paths
  measure the frame and close with `1009 message too large` instead of delivering it. A route that
  declares no cap is untouched and pays nothing: sizing a text frame costs a UTF-8 encode, so the
  measurement only runs where a cap exists.

## 2.11.0

## 2.10.0

## 2.9.1

### Patch Changes

- 9f6c9fc: Fix: `@nifrajs/deno` is now importable from npm under Deno.

  The package shipped only TypeScript source, with every export condition pointing at
  `./src/index.ts`. Deno refuses to strip types for any file resolved under `node_modules`
  (including its own npm cache), so `import { serve } from "npm:@nifrajs/deno"` - the form the
  README documents - failed with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` on every install.

  It now ships built `dist/index.js` + `dist/index.d.ts` and resolves `types`/`default` there, the
  same layout as `@nifrajs/node`. No API change: `serve()`, `ServeOptions`, and `DenoServer` are
  unchanged, and source maps still point at the shipped `src/`.

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
