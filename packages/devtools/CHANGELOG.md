# @nifrajs/devtools

## 4.0.1

### Patch Changes

- @nifrajs/otel@4.0.1

## 4.0.0

### Patch Changes

- aeb2756: The DevTools stream and `/state` snapshot require a loopback URL host (`localhost`, `127.0.0.1`, `[::1]` or `*.localhost`) as well as a loopback socket peer, as `allowRemote` documents. A request from this machine naming another host is refused unless `allowRemote` is set.
- be24b74: fix(devtools): construct on runtimes without `process`

  `devtools()` reads `NODE_ENV` through `globalThis.process`, so it constructs (disabled by default) on
  Cloudflare Workers without `nodejs_compat`.

- Updated dependencies [dde125b]
- Updated dependencies [72b62fa]
- Updated dependencies [aa44e93]
- Updated dependencies [4a3ee60]
- Updated dependencies [aad6297]
- Updated dependencies [dad0d41]
- Updated dependencies [538adc2]
- Updated dependencies [f47edd1]
- Updated dependencies [df9530a]
- Updated dependencies [3e6973f]
- Updated dependencies [25e8edf]
- Updated dependencies [2b5e5fc]
- Updated dependencies [3b090de]
- Updated dependencies [da7d792]
- Updated dependencies [612a296]
- Updated dependencies [fb14dfa]
- Updated dependencies [8ae97f6]
- Updated dependencies [4af6f39]
- Updated dependencies [ca8b50d]
- Updated dependencies [b00a889]
- Updated dependencies [b53d64f]
- Updated dependencies [66fd712]
- Updated dependencies [9c3d524]
- Updated dependencies [738e7a1]
- Updated dependencies [4801cac]
- Updated dependencies [1b2d53a]
- Updated dependencies [25fe13d]
- Updated dependencies [0852290]
- Updated dependencies [0589dbe]
- Updated dependencies [2e2d8c0]
- Updated dependencies [856f5ce]
- Updated dependencies [18aa5aa]
- Updated dependencies [cfd86b3]
- Updated dependencies [8ff96c9]
- Updated dependencies [4c46199]
- Updated dependencies [eef4932]
- Updated dependencies [6de8686]
- Updated dependencies [d7892ea]
- Updated dependencies [4936309]
- Updated dependencies [ff5a779]
- Updated dependencies [bbdc5a1]
- Updated dependencies [10bc446]
- Updated dependencies [e8270d9]
- Updated dependencies [ff4a062]
- Updated dependencies [43ba944]
- Updated dependencies [46c741a]
- Updated dependencies [7bfa25e]
- Updated dependencies [4936309]
- Updated dependencies [6e257a6]
- Updated dependencies [4a03d30]
- Updated dependencies [8e30090]
- Updated dependencies [28f3aaf]
- Updated dependencies [ac703a1]
- Updated dependencies [e1b89c0]
- Updated dependencies [1afbe9f]
- Updated dependencies [50e68d9]
- Updated dependencies [b8af5cf]
- Updated dependencies [6d87951]
- Updated dependencies [76b7aa8]
- Updated dependencies [6d20355]
- Updated dependencies [6907cbe]
- Updated dependencies [b64c3ee]
- Updated dependencies [bda9637]
- Updated dependencies [81c720e]
- Updated dependencies [ed60b23]
- Updated dependencies [a158b74]
- Updated dependencies [ff25d68]
  - @nifrajs/core@4.0.0
  - @nifrajs/otel@4.0.0

## 3.5.0

### Patch Changes

- @nifrajs/otel@3.5.0

## 3.4.0

### Patch Changes

- @nifrajs/otel@3.4.0

## 3.3.0

### Patch Changes

- @nifrajs/otel@3.3.0

## 3.2.0

### Patch Changes

- @nifrajs/otel@3.2.0

## 3.1.0

### Patch Changes

- @nifrajs/otel@3.1.0

## 3.0.0

### Patch Changes

- Updated dependencies [f3d2a35]
- Updated dependencies [6e43c15]
- Updated dependencies [f0fd370]
- Updated dependencies [86a555b]
- Updated dependencies [8c5f4cf]
- Updated dependencies [f0fd370]
- Updated dependencies [381bbf3]
- Updated dependencies [36801ae]
- Updated dependencies [9acadba]
- Updated dependencies [99fc683]
- Updated dependencies [73d894d]
  - @nifrajs/core@3.0.0
  - @nifrajs/otel@3.0.0

## 2.14.1

### Patch Changes

- @nifrajs/otel@2.14.1

## 2.14.0

### Patch Changes

- @nifrajs/otel@2.14.0

## 2.13.0

### Patch Changes

- @nifrajs/otel@2.13.0

## 2.12.1

### Patch Changes

- @nifrajs/otel@2.12.1

## 2.12.0

### Minor Changes

- 9a9346e: `app.use(plugin)` keeps the caller's server type. A plugin built with `definePlugin` whose input
  server type is not pinned used to widen the app to `Server<any, any>`, so every route declared
  before _and_ after the `use` lost its types and the typed client silently degraded to `any`. That
  case is now a compile error at the `use` call site, naming the definer to switch to; the plugin is
  unchanged at runtime.

  Pick the definer that matches what the plugin does: `defineContextPlugin<D>` when it adds context
  via `derive`/`decorate` (the registry threads through and `D` is added to every downstream handler
  context), `defineRouterPlugin` when it mounts routes/hooks and adds no context (mount as a side
  effect, return the app). `definePlugin` still works when its input type is pinned - annotate the
  parameter (`(app: typeof api) => ...`) or pass explicit type arguments.

  Every first-party plugin now threads: `jwt`, `tokenAuth`, `basicAuth`, `durableCommand`, `etag`,
  `compression`, `problemDetails`, `prettyJson`, `methodOverride`, `trailingSlash`, `cacheControl`,
  `devtools`, and `metrics` return an `IdentityPlugin`; `timing`, `language`, and `tracing` return a
  `ContextPlugin` of what they add (`{ timing }`, `{ language, languageMatch }`, and
  `{ trace, observation, causality }` respectively), so `c.timing` / `c.language` / `c.trace` are
  typed without a manual annotation. `combine(...)` is typed as an identity bundle and
  `namedCombine(name, ...)` is its deduped, named form.

  A type-level test asserts the threading for each definer shape, so a regression fails `typecheck`
  rather than surfacing as `any` in a downstream app.

### Patch Changes

- 0a91064: The loopback access gate reads the serving adapter's socket peer instead of the request URL's host.
  An adapter that reports a peer address decides the gate from that address alone (`127.0.0.0/8`,
  `::1`, and the IPv4-mapped `::ffff:127.x.x.x` form, with brackets and any zone suffix normalized
  away), so the inbound `Host` header no longer influences whether a caller counts as local. Runtimes
  with no socket peer, such as edge workers, keep the URL-host check.

  `allowRemote`, the origin check, and the optional `authorize` hook are unchanged.

- Updated dependencies [0efacea]
- Updated dependencies [9a9346e]
  - @nifrajs/otel@2.12.0

## 2.11.0

### Patch Changes

- @nifrajs/otel@2.11.0

## 2.10.0

### Patch Changes

- @nifrajs/otel@2.10.0

## 2.9.1

### Patch Changes

- @nifrajs/otel@2.9.1

## 2.9.0

### Patch Changes

- @nifrajs/otel@2.9.0

## 2.8.2

### Patch Changes

- @nifrajs/otel@2.8.2

## 2.8.1

### Patch Changes

- @nifrajs/otel@2.8.1

## 2.8.0

### Patch Changes

- @nifrajs/otel@2.8.0

## 2.7.1

### Patch Changes

- @nifrajs/otel@2.7.1

## 2.7.0

### Patch Changes

- @nifrajs/otel@2.7.0

## 2.6.1

### Patch Changes

- @nifrajs/otel@2.6.1

## 2.6.0

### Patch Changes

- @nifrajs/otel@2.6.0

## 2.5.0

### Patch Changes

- @nifrajs/otel@2.5.0

## 2.4.0

### Minor Changes

- 795357f: DevTools' request-trace buffer is now queryable, not just streamable.

  Alongside the live SSE overlay, the plugin serves a one-shot JSON snapshot at `/_nifra/devtools/state` - the recent request traces (method, path, status, duration, ISR status, response bytes), filterable by a `path` prefix and a `limit`, and guarded exactly like the stream (loopback-only unless `allowRemote`, origin-checked, optional `authorize` hook). A new `filterDevToolsEvents` export defines that query once, shared by the endpoint and its consumers.

  `nifra_inspect` (MCP) reads that snapshot for a running dev server, so an agent can SEE what its requests actually did - which route answered, the status, how long, ISR hit or miss - instead of inferring it from the response alone. It needs the app to mount the `devtools()` plugin (which auto-enables in development).

### Patch Changes

- @nifrajs/otel@2.4.0

## 2.3.0

### Patch Changes

- @nifrajs/otel@2.3.0

## 2.2.0

### Patch Changes

- @nifrajs/otel@2.2.0

## 2.1.0

### Patch Changes

- Updated dependencies [bd294bb]
  - @nifrajs/otel@2.1.0

## 2.0.0

### Patch Changes

- ade0c7a: Add a curated `@nifrajs/core/server` entry for the common HTTP runtime and dedicated subpaths for
  contracts, classification, cookies, logging, routing, Standard Schema, SEO, SSE, and webhooks. The
  package root remains backwards compatible, while new scaffolds and first-party runtime packages avoid
  eagerly parsing opt-in causality, invariant, manifest, reflection, capability, and assurance tooling.
- Updated dependencies [a7b1d60]
- Updated dependencies [eaac3d7]
- Updated dependencies [ade0c7a]
- Updated dependencies [82676e0]
- Updated dependencies [bc46cc9]
- Updated dependencies [1522d06]
- Updated dependencies [d91a45b]
- Updated dependencies [a7b1d60]
- Updated dependencies [a7b1d60]
  - @nifrajs/core@2.0.0
  - @nifrajs/otel@2.0.0

## 1.13.0

### Patch Changes

- @nifrajs/otel@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies [63d3845]
  - @nifrajs/otel@1.12.0

## 1.11.0

### Patch Changes

- @nifrajs/otel@1.11.0

## 1.10.0

### Patch Changes

- @nifrajs/otel@1.10.0

## 1.9.1

### Patch Changes

- @nifrajs/otel@1.9.1

## 1.9.0

### Patch Changes

- @nifrajs/otel@1.9.0

## 1.8.0

### Patch Changes

- @nifrajs/otel@1.8.0

## 1.7.0

### Patch Changes

- @nifrajs/otel@1.7.0

## 1.6.0

### Patch Changes

- Updated dependencies [d228ac4]
  - @nifrajs/otel@1.6.0

## 1.5.0

### Patch Changes

- Updated dependencies [bd3433f]
  - @nifrajs/otel@1.5.0

## 1.4.0

### Minor Changes

- 4d25970: Add one fail-open request-observation lifecycle shared by tracing, agent telemetry, and DevTools; secured development tooling; contract-based mock responses; validator-neutral schema/route reflection; executable render and storage adapter conformance modules; optional storage pagination/signing/copy capabilities; and metadata-preserving local file storage.

### Patch Changes

- Updated dependencies [4d25970]
  - @nifrajs/otel@1.4.0
