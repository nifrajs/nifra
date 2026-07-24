# @nifrajs/web

## 2.2.0

### Minor Changes

- 39b1670: `@nifrajs/web/dev` runs on Bun's native HMR, so the Bun pipeline no longer needs Vite anywhere.

  nifra has two dev pipelines and one rule between them: a pipeline owns a whole phase. The Vite server
  stays the default and now resolves SSR as well as the client, so both halves agree on every specifier.
  This is the other half of that split. `Bun.serve` bundles and hot-reloads the client, Bun's runtime
  resolves SSR, and only one toolchain is present - so the two cannot disagree. Previously this server
  rebuilt the whole client and forced a full page reload on every save; now Bun rebuilds incrementally and
  pushes over its own HMR socket.

  Joining the two halves takes some care, because Bun's dev server bundles HTML routes and nifra renders the
  document itself. A throwaway HTML route exists purely so Bun bundles the generated client entry and
  assigns it a URL, which nifra reads back and points its pages at. Three things follow from that, each of
  which is a silent failure if you skip it:

  - **The entry URL expires.** It is a content hash over the whole client graph, so any file the entry
    reaches re-hashes it. Pages therefore reference a stable nifra URL that redirects to whichever chunk Bun
    is currently serving. Injecting a remembered URL is not a stale-cache annoyance: Bun answers a
    superseded chunk with a `location.reload()` stub, so the page reloads, gets the same dead URL from SSR,
    and loops forever - with every reload wiping the console that would have explained it.
  - **Stylesheets have to be carried across.** Bun lifts `import "./app.css"` out of the JS graph and links
    it from the page it bundled, which is the throwaway. Without forwarding those links, the entire dev
    session renders unstyled while production, which reads CSS from the build manifest, is perfectly fine.
  - **SSR freshness is ordered by request, not by clock.** Bun rebuilds and reloads the browser the instant
    a file is saved, which is faster than any file watcher can answer; SSR rendered from a watcher tick is
    still on the previous code when that reload lands, and React discards the server tree with a hydration
    mismatch. Rebuilding when Bun's entry hash moves - the same value already fetched to render the page -
    removes the race instead of shrinking it.

  The client-leak guards still run. Bun's dev server does its own bundling, so the `buildClient` pass that
  enforces them is no longer on the path that serves the app; it now runs beside the dev loop, off the hot
  path, and reports. These stop server-only code and `node:` builtins reaching a browser, and a dev loop
  that quietly stops enforcing them is how a leak reaches a deploy. Opt out with `guardLeaks: false`.

  Reading Bun's output for the entry URL is isolated in one adapter with its own tests, including one that
  runs a real Bun dev server and fails if the markup Bun emits ever changes shape - so a Bun upgrade breaks
  a test rather than producing a dev server that boots cleanly and serves pages whose scripts 404.

  Both pipelines now report a port collision the same way, since `Bun.serve` throws synchronously where
  Node's http server emits an async `error` event.

- 1394641: Layout loaders: request data in the component that wraps every page.

  `routes/_layout.tsx` rendered, but a `loader` it exported never ran, so nothing request-derived could
  reach a layout - host, session, locale, feature flags, tenant. An app hit this and moved its host guard
  out of the component tree into the server entry, where it could not be typechecked with the rest of the
  app. That is the real cost: the gap pushed security-relevant code to the one place nifra's typed-boundary
  promise does not reach. Remix, React Router and SvelteKit all support this; nifra was alone in not.

  ```tsx
  // routes/orgs/[org]/_layout.tsx
  export const gate = true                       // optional; see below
  export async function loader({ params, req }) {
    return { org: await findOrg(params.org) }    // params is { org } — nothing deeper
  }
  export default function Layout({ data, children }) { … }
  ```

  **Scoped, not global.** A layout owns the URL prefix it wraps, so it receives only the params inside
  that prefix and its loader is skipped on a navigation that did not change them. Navigating
  `/orgs/acme/a` → `/orgs/acme/b` does not re-run the org layout's loader. Scope is derived at build time
  per `(route, layout)` pair, because one layout can own different params on different expanded patterns:
  `[[lang]]/docs/_layout` owns nothing on `/docs/:slug` and `{lang}` on `/:lang/docs/:slug`. Layouts are
  not router nodes and did not become any - the router is untouched.

  **Execution order is declared, and this matters for security.** By default a layout loader runs in
  parallel with the page's, which is right for data and wrong for a guard: a page loader running
  concurrently with a guard has already queried by the time the guard says no. `export const gate = true`
  makes a layout blocking - nothing beneath it runs until it resolves, and nothing beneath a rejected gate
  runs at all. **A layout loader without `gate: true` is not an authorization boundary.** Gates also run on
  the data-only request, so a client navigation cannot bypass one by sending the data header, and a gate is
  never skipped by the retention hint.

  A layout may throw `notFound()` / `gone()` / `redirect()`. Its errors resolve to the `_error` boundary at
  or above its OWN segment, never one below it - rendering there would wrap the boundary in the very layout
  whose loader just failed.

  Every adapter passes each layout its own data. A layout with no loader receives `null`, and an app where
  no layout has a loader emits byte-identical HTML and unchanged props.

  The data-mode response becomes a versioned envelope when a chain carries layout data. It is recognised
  by structure, and the bare pre-envelope shape is still accepted - a prerendered `_data.json` is a static
  file that outlives the deploy that wrote it.

- e713cab: Let a route loader answer 404 and 410.

  A matched route whose loader finds nothing had no supported way to set its page's status, so the path
  of least resistance was to return empty data and render "not found" inside a **200**. That is a soft
  404: search engines penalise it and keep the dead URL indexed, and because the page looks correct in a
  browser it ships and stays shipped. It is the most common page shape there is - a detail route whose
  record may not exist.

  `notFound()`, `gone()`, and `statusPage(status)` are thrown from a loader, the way `redirect()` already
  is. They render the `_404` page - or `_410.tsx` / `_<status>.tsx` if the app authored one - inside the
  normal layout chain, hydrated, at the right status. A `headers` option carries the cache policy each
  status wants: a 404 may be racing publication and wants a short TTL, while a 410 is a promise that the
  URL is permanently gone. Typed `never`, so a loader narrows without a redundant `return`.

  410 is not a pedantic 404: it tells a crawler to drop the URL instead of re-fetching it for weeks.

  Existing behaviour is unchanged by construction. The signal is a branded `Response` and the brand is
  checked before the verbatim pass-through, so `throw redirect(...)`, `throw new Response(...)`, and a
  real `Error` reaching `_error` all behave exactly as before. Client-side navigation and prerendering
  already handle a non-ok render correctly and now have tests pinning that: a soft-nav falls back to a
  full navigation and lands on the same page, and a prerendered path whose loader signals is omitted
  from the build rather than baked as a static 200 shell.

  `renderPageResult` gains a `headers` option. `content-type` and the ISR freshness header stay
  framework-owned and cannot be overridden through it.

  Also trims the router's rejected-parameter message added in the previous release. The explanation cost
  ~0.3 KB gzip in every bundle; it now states the grammar rule and the two ways out without building an
  example path, which is a third smaller and keeps the base bundle inside its budget.

- a4645e2: Support path segments that are part literal, part parameter.

  A route segment had to be wholly static, wholly a parameter, or wholly a wildcard. `/:key.txt`,
  `/post-[id].html` and `/[locale]-sitemap.xml` did not merely fail to match - they failed to
  **compile**. The trigger was an IndexNow key-verification file, which the protocol requires at
  `<origin>/<key>.txt` with the key coming from deploy-time config, and at the root, because a key
  served from a subdirectory only authorises URLs beneath it. The workaround was an exact-match check in
  the app's server entry, which moved a routing concern out of the router and never ran in dev.

  Both spellings now work: `:key.txt` in a route pattern, and `[inKey].txt.tsx` as a file route. The
  parameter name is the longest identifier run after `:`; everything else in the segment is literal.
  Precedence is static > mixed > param > wildcard, decided by shape rather than registration order, so
  `/robots.txt` still beats `/:key.txt` and `/jobs/:id.txt` beats `/jobs/:id`.

  Inside a mixed segment, `[[optional]]` and `[...catchAll]` are **rejected** at build time rather than
  given a meaning: there is no sensible absent form for `/[[locale]]-feed.xml`, and a catch-all captures
  the rest of the path, which a trailing literal can never follow.

  **Literal colons keep their meaning.** A `:` that follows an identifier character and runs to the end
  of its segment is literal, so the established RPC-style action shape - `/v1/things:batchGet` - still
  routes as written rather than capturing `batchGet` into a parameter named after the verb. Mixed
  parameters remain available everywhere they are unambiguous: at the start of a segment (`/:key.txt`),
  after punctuation (`/post-:id`), or with a literal suffix (`/v:major.json`). A `:` not followed by a
  valid identifier start (`/ratio:2`) is literal as before.

  Mixed siblings are ordered by ONE total comparator shared between the server's trie router and the
  browser's matcher. Ordering by literal weight alone left ties broken differently on each side, so
  `/bar.:value` and `/:value.foo` could resolve to different routes for the same URL - visible only as a
  soft navigation rendering the wrong page.

  Adding a mixed pattern can also make a previously unambiguous path ambiguous: with both `/jobs/:id` and
  `/jobs/:id.txt` registered, `/jobs/a.txt` now matches the mixed route with `id="a"` where before it
  could only match the bare param with `id="a.txt"`. Deterministic, and only for apps that opt in by
  registering a mixed pattern.

  An app that registers no mixed segment allocates nothing for this and pays one `undefined` check on
  the match path. The rejected-parameter hint added in the previous release is removed - `:id.json` was
  the shape it explained, and `:id.json` now compiles.

- a7d740a: Mount sub-apps and standalone-shaped backends without a `Proxy`; bound the render worker; lint removed imports.

  **`mounts` and `apiStrip` on `createWebApp`.** Two shapes previously needed a hand-written ~40-line
  `Proxy` around the backend. The auto-mount dispatches the full `/api/v1/forms`, but a backend that also
  runs standalone declares its routes without the prefix and lets its own shell supply it - so every
  request 404'd inside it. And better-auth is not a `backend` route, so `/api/auth/*` hit the backend and
  404'd silently. `apiStrip: true` removes the prefix before dispatch, and `mounts` takes any
  `{ path, app: { fetch } }` - so any library exposing its routes in that shape mounts directly, with no
  dependency from `@nifrajs/web` on it. Mounts are matched longest-path-first and before the `api`
  prefix, so `/api/auth` wins over `/api` regardless of declaration order.

  **A layout that exports a `loader` now fails loudly.** Layouts do not run one - only route files do -
  and rendering while ignoring the export was the worst possible handling: it looks wired, the page
  renders, and the data is simply never there. The error names the file and says where the fetch should
  go instead. Running loaders in layouts is a real feature and is not this change.

  **`nifra_render` and `nifra_run` can no longer hang.** The cold-path child wrote its result and then
  fell off the end of the module without exiting, unlike the warm-worker branch beside it. Loading an
  app runs its module side effects, so a database pool, a Redis client, or an interval kept the child's
  event loop alive forever while the parent waited on `proc.exited`. The child now exits explicitly, and
  both the cold and warm paths carry a 30s timeout as a backstop, reporting the likely cause rather than
  hanging.

  **A `removed-import` lint in `nifra check`.** `@nifrajs/budget` folded into core in 2.x with no npm
  deprecation - `latest` is still 1.13.0, so a `^2` range resolves to nothing and `bun install` fails
  workspace-wide with an error naming neither cause nor replacement. The 2.0 WebSocket change has the
  same shape: `import "@nifrajs/core/ws"` no longer installs the runtime, and a consuming package kept
  it while its whole test suite stayed green and the app could not boot. Both are now caught before
  boot, with the replacement named. The WS rule flags only the bare side-effect form, since the module
  still exports `websocket` and a rule that fires on correct code gets ignored.

- 6e996a1: A dev/prod parity gate, and the CSS Modules divergence it immediately found.

  nifra runs two pipelines and each is internally coherent: dev is Vite end to end, production is Bun end
  to end. That split is deliberate. What is not acceptable is the two regimes disagreeing about a fact an
  app depends on, because that failure always presents the same way - as "it worked locally", discovered
  after a deploy. The gate builds one fixture app through both pipelines and asserts they agree on four
  facts, each of which is a bug that already shipped or the mechanism behind one: the served `public/` set
  (byte-for-byte, not just the path list), that a module imported by two routes stays one module, CSS
  Modules behaviour, and the route manifest.

  Scoped CSS class names are deliberately not compared. A scoped name never crosses the regime boundary,
  since each regime compiles both of its own halves, so requiring equal hashes would freeze both naming
  schemes forever while proving nothing. What is compared is the contract: the same exported keys, every
  one actually scoped, and `:global` left alone on both sides.

  That comparison found a real divergence on its first run. `@keyframes` names are part of the CSS Modules
  export namespace - postcss-modules exports them, so Vite does, so nifra's dev pipeline did - but the Bun
  plugin omitted them. `styles.spin` was therefore a usable scoped name in dev and `undefined` in
  production, with no error at either end. Keyframe names are now exported, so anything reaching for one
  (`style={{ animationName: styles.spin }}`) behaves the same in both.

  When a file has both a class and a keyframe under one name, the class wins the export. That resolution is
  fixed by construction rather than by declaration order, because a name that has to agree across two
  pipelines cannot depend on which rule was seen first; the keyframe stays scoped in the stylesheet under
  its own distinctly salted name either way.

  `createViteDevServer` also now reports the port it actually bound rather than the one it was asked for.
  They differ for `port: 0` - the way to ask the OS for a free port, and what a test or a second app wants -
  where it previously echoed back a literal `0`, which connects to nothing.

- 6aa0aac: Add `previewEndpoint` for draft/preview mode, and make transport codec decode errors uniform.

  `previewEndpoint({ secret, draftSecret })` is a `fetch` handler for the link your CMS's "Preview"
  button points at: it checks the preview token in constant time, turns draft mode on with the signed
  `__nifra_draft` cookie, and redirects the editor to the requested page. It is the link-borne sibling
  of `revalidateEndpoint`, and it exists because gating the route by hand means writing two checks that
  are easy to get subtly wrong and that fail silently when you do - the token compare must not exit
  early on the first wrong character, and the `?to=` destination must not be allowed off-site
  (`//evil.com` and `/\evil.com` both start with a slash yet navigate away). Wrong or missing token
  gives `401`, an off-site destination `400`, and success a `302` carrying `Cache-Control: no-store`
  so no shared cache can replay one editor's draft session to a visitor. Param names, the fallback
  destination, and cookie lifetime/path/`Secure` are all configurable.

  `decodeTransportFrame` and `decodeTransportResponse` now raise `TransportCodecError` for a malformed
  payload instead of letting the underlying `SyntaxError` through, with the original kept as `cause`.
  Every other failure in that module was already a `TransportCodecError`, so a malformed payload - the
  likeliest hostile input - was the one case that slipped past callers catching the documented error
  type. `TransportCodecError` accepts an `ErrorOptions` second argument to carry that cause. Bytes that
  are not valid UTF-8 take the same path: the `TypeError` from the strict decoder used to escape ahead
  of any codec, so the one input that never reached a codec at all was also the one that reported
  differently from every other decode failure.

- 1857d39: Serve `public/` in production, not just in dev.

  `nifra dev` served a project's `public/` directory; production did not. There was no `publicDir`
  concept anywhere - dev got the behaviour for free because the HMR path runs on Vite, and Vite serves
  `public/` by default. So a file worked all the way through development and 404'd the moment it was
  deployed, and every app had to notice this and hand-roll static serving in its own server entry.

  The failure is inverted, which is what makes it expensive: it appears only in production, and only for
  the assets nobody smoke-tests. It has already shipped once as a self-hosted webfont that 404'd in prod
  and silently fell back to a system font. Nothing errored and nothing alerted.

  `publicDir` (default `"public"`) is now a first-class option. The build copies the directory into the
  output and records the file list on the build manifest, and `servePublicDir` is exported for a server
  entry to mount. Dev routes through the **same** handler rather than inheriting Vite's - two code paths
  with different defaults was the whole bug, so there is now one owner.

  Behaviour, matching what apps arrived at independently: only paths with a file extension are probed,
  so a page route never pays a filesystem stat; a miss falls through to routing, so no route is shadowed;
  and cache headers differ by subtree - content-hashed `/assets/*` immutable, `public/` a day, both
  overridable. Path traversal is confined by resolving and then verifying containment, rather than
  scanning the input for `..` - a blocklist over encodings is the version that gets bypassed - and
  percent-encoded and NUL-bearing paths have tests.

  Note that `publicPath` is a different thing: the URL prefix for content-hashed bundle chunks. It never
  covered user-authored files, and the name similarity actively misleads.

  `nifra check` now points out that an app with a `public/` directory can delete its hand-rolled static
  serving. A tip rather than a finding - an existing handler still works, since it runs first.

  On Cloudflare Pages the copied files are named individually in `_routes.json` so the CDN serves them
  without invoking the worker, within Cloudflare's cap of 100 include+exclude rules of at most 100
  characters each. An ordinary `public/` of icons, fonts and share images clears that cap, and the
  rejection lands at `wrangler pages deploy` - after a build that reported success.

  Past the cap a directory is compacted to one `/dir/*` rule, but only after checking it against the
  app's real route patterns. The glob does not merely describe today's files; it hands Pages every future
  path under that prefix, so a `public/blog/hero.png` beside a `/blog/:slug` route would send
  `/blog/my-post` to a CDN that has no such file and 404 the page in production only. A directory
  therefore collapses only when no route can be served beneath it, and a single route with a dynamic
  first segment (`/:locale/…`) disables collapsing everywhere, since it can match under any name. A
  collapsed directory does give up the app's 404 page for a missing file beneath it - the right trade for
  a directory of static files, where a missing image should fail as a fast CDN 404 rather than an HTML
  error page.

  Whatever still does not fit is dropped rather than widened, which is safe because the list is only an
  optimization: the emitted worker serves any path it recognises through the `ASSETS` binding, so an
  omitted file costs one worker invocation rather than a 404, and nothing else reaches that binding. The
  build prints how many it left out, since a cap you cannot see reads as coverage you do not have.

- 6ba3173: `nifra routes --modes` — every route's render mode, hydration, and cache policy, gated against the target.

  The facts were always in the route modules: `prerender`, `getStaticPaths`, `revalidate`, `hydrate`.
  Nowhere read them together. Answering "which pages are static?", "which revalidate, how often?", "which
  ship no JS?" meant opening every route file and holding the answer in your head - and the answer changes
  with the deploy target, which is nowhere near the route file.

  The new `@nifrajs/web/route-manifest` derives one record per route - static | isr | ssr, hydration, cache
  policy - and resolves it against a target. `nifra routes --modes` prints the table; `--modes --target <t>`
  gates: a route the target cannot honour exits non-zero, so CI fails the build instead of production
  failing the request. The two cases that were previously silent are exactly the ones it catches: an ssr or
  isr route in a `static` build (no server, so the URL 404s in production while working in dev), and ISR
  where the target has no revalidation. Each conflict names the consequence, not the rule.

  Two derivations are deliberate. `prerender` wins over `revalidate`, because a page rendered at build time
  is not revalidated at runtime - the build-time answer is the one that ships. And a dynamic route counts as
  static only once the build has actually emitted paths for it: `getStaticPaths` is the intent, the emitted
  paths are the evidence, and treating intent as sufficient is how a "static" build ships a page that 404s.
  Pass the paths `prerenderRoutes` produced via `buildRouteManifest`'s `prerendered` option to resolve those
  routes against what was really built.

- 0fc215b: The Vite dev pipeline now resolves SSR too, which removes the dual-React class of bug.

  `nifra dev` served the client through Vite while resolving route modules for SSR through Bun - two
  resolvers disagreeing about one specifier, inside one process. That is what made `resolve.dedupe`
  govern only half the app: an app added a hand-written React alias in `nifra.config.ts`, and it still
  crashed, because the alias reached Vite and SSR never asked Vite. The symptom named a React internal
  (`resolveDispatcher().useState` is null), so the actual cause - two copies at different paths - was
  hours of inference away.

  `discoverRoutes` accepts a `load` option, and the Vite dev server passes `ssrLoadModule`. Both halves
  now resolve through the same toolchain, so an alias, a `dedupe`, or a condition configured for the
  client governs the server as well.

  Two things follow from that and are removed rather than kept "just in case":

  - **Bun's SFC plugins are no longer registered in `nifra dev`.** Vite compiles `.vue` / `.svelte` /
    Solid for SSR through the app's `vitePlugins`. Registering Bun's alongside was the intermix itself -
    two toolchains compiling one file, only one of them governed by Vite's resolution. `nifra start` and
    the build path keep theirs, which is correct: those are the Bun pipeline.
  - **The `importQuery` cache-buster is gone from the Vite path.** It existed to defeat Bun's import
    cache; Vite re-evaluates changed modules itself. `discoverRoutes` ignores `importQuery` when `load`
    is supplied, because appending one would mint a new module id per request and defeat that.

  The dev server still re-creates the app on change, now only so a hard reload picks up a route add or
  remove - the manifest comes from a directory scan, which `ssrLoadModule` cannot invalidate.

- 2ff661f: The full Vite/Rollup production build: `buildClientVite`, `buildServerVite`, `buildTargetVite`, and `nifra build --vite`.

  Production stays Bun by default - faster and Bun-native, the profile nifra is tuned for. This completes
  the escape hatch for the one case that default cannot serve: an app whose client needs a Vite-only
  transform with no Bun equivalent. It now has a real, full production path, not just the leak-guard plugin.

  The design point is that this is NOT a second orchestrator. `buildTarget`'s deploy assembly - per-target
  server-entry codegen, `_worker.js` / `server.js` placement, `_routes.json`, prerender, size report - is
  bundler-agnostic and now lives behind `buildTargetWith(target, options, bundler)`, which takes a `Bundler`
  strategy (its two bundling steps). `buildTarget` passes the Bun strategy; `buildTargetVite` passes the
  Vite one. So the deploy-dir shape is produced in exactly one place and cannot drift between pipelines -
  `buildTargetVite` emits the identical directory for every target.

  `buildClientVite` reconstructs the same `BuildManifest` the Bun `buildClient` does - content-hashed entry,
  per-route chunk lists, aggregate + per-route CSS, copied `public/` - from Vite's own `.vite/manifest.json`.
  It wires `viteLeakGuard()`, and it keeps `node:` builtins external so the guard names the offending builtin:
  left alone, rolldown-vite silently rewrites a `node:` import to a browser stub, which builds and ships and
  is a no-op at runtime - a worse footgun than Bun's polyfill, now a build failure. `buildServerVite`
  produces the same self-contained `ServerBuild`, tagging the bundle `NIFRA_SSR_BUNDLED` so the web-react
  adapter uses the bundled, deduped react-dom rather than re-rooting to a disk copy.

  `nifra build --vite` selects the pipeline; the app's Vite plugins drive both halves. Verified end to end by
  building the React example for the `node` target, running the server, and confirming SSR plus live
  hydration in a real browser, alongside `cf-pages` (`_worker.js` + `_routes.json`) and `static` (prerender,
  no server) deploy shapes.

  No change to the default Bun build: `buildTarget` now delegates to `buildTargetWith` with the Bun strategy,
  and its behaviour and output are identical.

- a1327a4: A Vite/Rollup production build carries the same client-leak guards as the Bun build.

  Production stays Bun by default - it is faster and Bun-native, and that is what nifra competes on. But
  some apps need a Vite-only transform with no Bun equivalent, and for those a Vite/Rollup production client
  build is the escape hatch. The moment that hatch exists, the two client-leak guards have to come with it:
  they are security guards, not lints - one stops secrets and database access shipping to a browser - and a
  second production pipeline arriving without them, or with a "mostly ported" copy, is exactly the failure
  the bundler-neutral module graph was introduced to prevent.

  `@nifrajs/web/plugins/vite-leak-guard` is not a second implementation. It adapts Rollup's bundle into the
  neutral `ClientModuleGraph` (`fromRollupBundle`) and runs the SAME `detectNodeBuiltinsInClient` /
  `detectServerOnlyInClient` the Bun build runs, through the SAME failure messages - now extracted so both
  pipelines share one owner. A `node:` builtin or a `server-only`-marked module reaching the client fails
  the build identically whichever bundler produced it, including via dynamic `import()`.

  One adapter subtlety is load-bearing: the guards locate a leak by finding the builtin inside a chunk's
  module list. Bun bundles the `node:` polyfill, so it appears there; Rollup externalizes `node:`, so it
  never would - the adapter synthesizes the builtin into the importing chunk so the neutral graph is
  identical to Bun's. Proven with a real `vite build` that fails on a real leak (static and dynamic) and
  passes clean code, alongside unit tests asserting the two adapters yield the same finding.

  No behaviour change for existing Bun builds: the guard logic and messages are unchanged, only relocated
  behind shared formatters.

### Patch Changes

- d428f52: `nifra dev` names a port collision instead of dying inside `node:events`.

  Starting the dev server while an earlier one still holds the port produced a raw internal stack from
  Node's event emitter and killed the new process in the background. The old server kept answering on that
  port, so the browser carried on rendering the previous build. The symptom that reaches the developer is
  not "the port is taken" but "my edits stopped reaching SSR" - which reads as broken HMR or a stale module
  graph and sends you looking anywhere but at the one process that never started.

  Binding now fails with the port named, the stale-output consequence spelled out, and both fixes given
  with the port already substituted: free it, or take the next one. Vite is torn down on that path, because
  by the time the bind is attempted its watchers and dep optimizer are holding the event loop open - a
  handled error alone would leave the process printing a diagnosis and then hanging on it, which looks
  exactly like a dev server still starting up. Other bind failures pass through unchanged rather than
  inheriting port-collision advice that would not apply.

- 135d0c6: Find duplicate installs when `nifra check` runs from an app subdirectory.

  The duplicate-install check anchored its discovery at the directory it was run from. In a monorepo you
  run it from the app - `apps/web` - and that manifest declares no `workspaces`, so the scan collapsed to
  the app itself and the sibling package holding the second copy was never probed. It printed
  `✓ duplicate identity-sensitive dependency install: none` while the dev server returned 500 on every
  page using a shared-kit hook, from exactly the condition the check exists to detect. Running from an
  app subdirectory is the normal case, so that was the configuration it was blind in.

  Discovery now walks up to the workspace root that actually governs the directory, and probes from
  there. An ancestor is adopted only when its `workspaces` patterns genuinely match - a parent that
  merely contains a manifest is not this project's root - and the walk stops at a `.git` boundary.
  Findings are still reported relative to where you ran the command.

  **Expect this to start reporting real findings in monorepos that were previously green.** That is the
  point rather than a regression: the duplicate was always there, and the check simply never looked in
  the right place.

  An SSR error carrying a duplicate-instance signature (`resolveDispatcher()`, `Invalid hook call`, a
  null hook read) now names the likely cause. Two copies at the same version still fail, because module
  identity is path-based, and the raw error points at a React internal - so the message now says two
  copies are installed at different paths, that matching versions do not fix it, and to run
  `nifra check` for the paths.

- 15ad6ca: Enforce pipeline separation, and make the client-leak guards bundler-neutral.

  nifra supports both Vite and Bun, and the config already keeps them in separate slots - `vitePlugins`
  for the Vite pipeline, `clientPlugins` / `serverPlugins` for the Bun one. Nothing enforced the split,
  and the failure mode is silent: `Bun.build` has no `transform` hook and Vite never calls `setup`, so a
  plugin in the wrong slot is accepted, never invoked, and the build succeeds with the transform simply
  missing.

  Loading an app now refuses that config, naming the plugin, the slot it is in, the pipeline that slot
  feeds, and where to move it. Checked at load rather than in `nifra check`, which holds a deliberate
  pre-`loadApp` invariant - reading plugins means importing the app's config. So `dev`, `build` and
  `start` are covered from one place, immediately before the plugins reach a bundler. Detection is by
  hook shape and deliberately conservative: a plugin matching neither shape is left alone, because a
  guard that fires on correct config is a guard people turn off.

  The two client-leak guards - server-only code reaching the browser, `node:` builtins in client code -
  now take a bundler-neutral module graph instead of Bun's metafile, with a `fromBunMetafile` adapter
  behind it. Nothing changes today: Bun remains the only producer and the existing 19 tests pass
  unchanged, now routed through the adapter so it is covered too.

  The point is what it makes possible. These are security guards - one stops secrets and database access
  shipping to a browser - so a second production pipeline must not arrive without them, and porting them
  under pressure beside a new bundler is how a guard ends up "mostly" ported. Introducing the seam while
  Bun is the only producer means the adapter can be verified against known-good behaviour, and adding
  Rollup later is one more adapter rather than a second copy of the detection logic.

- ca71a2e: `nifra_types` collapses oversized declarations in search results, and a bad `clientModule` says so.

  **`nifra_types` query mode.** A search returned the complete declaration of every match, and the corpus
  is wildly uneven: the median symbol is small while `Server` alone is ~32,000 characters, five times the
  next largest. One broad query that happened to match it returned the entire class for near-zero value.

  A `query` now returns a one-line summary plus the signature, collapsing an oversized body to its head
  and a member count, and saying which `name` call returns the rest. Measured on the real corpus:
  `"server"` drops from 36,355 to 1,739 characters (95%), `"route schema"` by 87%, `"rate limit"` by 69%.

  An exact `name` lookup is **never** collapsed - there the caller asked for that symbol. Pass
  `full: true` to opt a query back into whole declarations.

  **`clientModule`.** The option is a module specifier resolved by the bundler, so nothing type-checks
  that the module actually exports `mountRouter`. A self-executing client entry therefore built cleanly
  and failed at first paint with `mountRouter is not a function`, from inside a bundled chunk, naming
  neither the module nor the requirement - diagnosable only by reading `build.ts`.

  The generated bootstrap now throws immediately, naming the offending specifier, the missing export, its
  call signature, and the specific trap that a self-executing entry will not work. The contract is also
  spelled out on the option's own type rather than in a parenthetical.

- 2500705: The Vite production build now works on runtimes whose `Error.captureStackTrace` is stricter than V8's.

  `captureStackTrace` is a V8 API and V8 decorates any object handed to it. Some runtimes require a real
  Error - one with the internal slot, which an object merely inheriting `Error.prototype` does not have -
  and throw `First argument must be an Error object`.

  Vite bundles `follow-redirects`, which defines its error types the pre-class way:

      CustomError.prototype = new (baseClass || Error)()

  That constructs the base class while defining the subclass, so `captureStackTrace` receives an object
  that inherits from Error but was never built by it. On a strict runtime the throw happens while vite's
  own module is still evaluating, so `import("vite")` fails outright and every Vite build dies with a
  message about stack traces that names nothing about vite.

  `loadVite` now probes for that strictness and, only when present, restores the V8 contract: it delegates
  to the runtime and swallows the refusal, since decorating a stack is best-effort. A runtime that already
  follows V8 is left untouched.

  Also: a Vite build that fails for any reason no longer reports "vite is not installed" when vite is
  installed and merely failed to load - a resolution failure and an evaluation failure are now described
  as what they are.

- Updated dependencies [5f460db]
- Updated dependencies [e713cab]
- Updated dependencies [a4645e2]
- Updated dependencies [6aa0aac]
  - @nifrajs/core@2.2.0

## 2.1.0

### Minor Changes

- bd294bb: Add `executeCapability()` as a correlated, policy-aware effect boundary.

  - Correlate intent and terminal evidence with a random `effectId`, record committed/failed outcomes
    automatically, and combine request cancellation with bounded async `aroundCapability()` admission
    policies while preserving the synchronous `useCapability()` path.
  - Retain idempotency results for every completed response, including non-2xx outcomes, so a retry
    cannot repeat an effect that succeeded before a later handler failure.
  - Add durable approval, effect journal, saga/compensation, and reconciliation primitives behind the
    `durable-execution` subpath, plus token-only OpenTelemetry effect spans from `@nifrajs/otel/effects`.
    Reconciliation supports bounded cursor pages, approval resume tokens stay out of ordinary error
    serialization, durable terminal states are monotonic, crash ambiguity has an effect-ID-bound operator
    resolution API, and unmatched effect spans have bounded retention.
  - Add one shared owned-effect scope across capabilities, saga execution, compensation, idempotency
    evidence, durable transitions, and telemetry. An explicit `markIdempotencySafeToRetry()` outcome
    releases a resolved 5xx only while the scope proves no effect began.
  - Add negotiated, versioned transport codecs with bounded plain-JSON and rich-wire adapters for HTTP,
    the typed client, loader NDJSON, and WebSocket frames.
  - Add Postgres, SQLite, and Durable Object durable-execution adapters with one reusable conformance
    suite, plus leased reconciliation workers with bounded pages/concurrency, durable cursors, filters,
    cancellation, backpressure, and token-only metrics.

### Patch Changes

- Updated dependencies [bd294bb]
- Updated dependencies [d3aac63]
  - @nifrajs/core@2.1.0

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

- d91a45b: The in-process backend mount is now exclusively the symbol-keyed `BackendMount` interface that `inProcessClient()` / `testClient()` implement.

  `createWebApp({ api })` auto-mounts a backend only through that symbol seam - the platform-aware path that forwards `env` / `waitUntil`. The `.fetch(url, init)` mount convention is gone: an `api` that only exposes a callable `.fetch` is no longer auto-mounted. Backends passed as `inProcessClient(app)` / `testClient(app)` are unaffected, since they carry the symbol mount already.

### Minor Changes

- e97a92f: `nifra sync-manifest`, plus two toolchain guards that turn opaque failures into actionable ones.

  - **`nifra sync-manifest`.** After adding/renaming/removing a page route, the committed `server-manifest.ts` drifts and `nifra check` flags it - and clearing that used to mean a full build (server + worker + migrate bundles). `nifra sync-manifest` re-scans `routes/` and rewrites just the manifest's route table in milliseconds, preserving the baked client-asset references. It does not rebuild the client bundle, so it prints a caveat: a brand-new hydrating route component still needs a full build for its client chunk. `@nifrajs/web/build` gains the pure `resyncServerManifestSource` (+ `parseManifestStyles` / `parseManifestRouteStyles`) it is built on.
  - **`nifra dev` peer preflight.** Run under `bunx @nifrajs/cli dev` (an isolated install where the project's peers do not resolve), the Vite import failed with an opaque `ERR_MODULE_NOT_FOUND`. It now checks `vite` resolves from the project first and, if not, says to run the workspace-local `bun run dev`.
  - **`nifra start` build-target guard.** Pointed at a Cloudflare Pages output (a `_worker.js` bundle, no `server.js`), `nifra start` now names the mismatch and the fix (`nifra build --target bun`, or serve with `wrangler pages`) instead of a bare "no server.js".

- e8e49d1: Two new build plugins for the `Bun.build` production step, both opt-in and dependency-free until used.

  - **`postcssBunPlugin` (`@nifrajs/web/plugins/postcss`)** - runs `*.css` / `*.pcss` / `*.postcss` through PostCSS, feeding the result into the existing stylesheet pipeline (and the CSS-modules scoped-class transform for `*.module.*`). This is the Tailwind v4 path: a `postcss.config.js` with `@tailwindcss/postcss` compiles `app.css` importing `tailwindcss` at build time with no framework-specific code. `postcss` (and `postcss-load-config`, when you don't pass `plugins` explicitly) are optional peers, loaded lazily and failing loud with an install hint. Mirrors the SCSS plugin: pass `"dom"` for the client bundle, preload `"ssr"` for the server.

  - **`svgComponentBunPlugin` (`@nifrajs/web/plugins/svg`)** - import an SVG as a component, `import Icon from "./icon.svg?component"`, then `<Icon className="w-6 h-6" />` with props spread onto the root `<svg>` (the Vite `svgr` workflow). Emits an automatic-JSX-runtime component, so it works for React and Preact today; Solid/Svelte/Vue are out of this version. Optional `svgo` optimization. A plain `import "./icon.svg"` asset URL is untouched - only the `?component` marker is intercepted.

- a7d34e5: Navigation loading UI for `@nifrajs/web-react/router`, plus a per-link pending signal.

  nifra navigates imperatively - it fetches the next route's chunk and loader data while the current route stays on screen, then swaps - so a route transition is signalled by the router's `pending` flag, not a Suspense boundary.

  - `useNavigation()` returns `{ pending, state: "idle" | "loading", location }` (Remix-shaped); `location` is the `pathname + search` being navigated to while pending. `usePending()` is the boolean form.
  - `NavLink`'s render-prop `isPending` is now real: it is `true` while a navigation to that link's own target is in flight (matched like `isActive`), so a link can show its own spinner. Previously always `false`.
  - The agnostic router now publishes `pendingPath` (the navigation target) on its state while `pending`, and `compose` threads `pending`/`pendingPath` into the router context. Both are `false`/absent on the server and the initial client render, so they are hydration-safe.

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

## 1.13.0

### Minor Changes

- 5b6127a: Make route batches atomic, seal server configuration after `listen()`, encode array query values as
  repeated keys, and align web route matching with the server.

  Three behavior changes to know about:

  - **Configuring a server after `listen()` now throws** instead of reaching some traffic and not the
    rest. Bun's native route table is compiled when you listen, so a hook added afterwards applied to
    `app.fetch()` but not to real HTTP requests: an `onRequest` guard installed late was silently
    skipped on the wire. Register routes, hooks, plugins, and context before listening.
  - **Array query values serialize as repeated keys** (`?tag=a&tag=b`), not `?tag=a%2Cb`, so a route
    whose `query` schema declares an array now receives one.
  - **The web matcher applies the server's trailing-slash rule.** `/users/7/` no longer matches
    `/users/:id` in the browser, matching the 404 the server already returns, and a malformed percent
    encoding reports no route instead of throwing.

  A route batch from `implement()` or `merge()` commits only once every route in it validates, so a
  collision partway through leaves matching and reflection untouched instead of stranding the routes
  registered before it.

  Each route now owns one immutable compiled execution plan shared by portable, Node-direct, and
  Bun-native dispatch. This also fixes validation recovery being skipped when a derive moved a route
  from a specialized lane to the generic lifecycle.

  Core, browser navigation, Bun-native parameter metadata, and mock routing now consume the same
  compiled pattern kernel. Static routes beat parameters and parameters beat wildcards regardless of
  manifest order, with one grammar, trailing-slash policy, and malformed-encoding rule.

### Patch Changes

- Updated dependencies [aae8614]
- Updated dependencies [5b6127a]
  - @nifrajs/core@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies [63d3845]
- Updated dependencies [246f498]
  - @nifrajs/core@1.12.0

## 1.11.0

### Minor Changes

- 5638ada: Add an explicit symbol-keyed in-process backend mount interface. `inProcessClient` implements the
  interface and `createWebApp` forwards the outer request's platform context through it, so an
  auto-mounted backend receives the same Workers `env` bindings and `waitUntil` lifetime as the web app.

  The released `.fetch(url, init)` duck-typed mount remains as a compatibility fallback for custom
  bridges. `Server.onRequest` now receives the optional platform object as its second argument.

### Patch Changes

- Updated dependencies [2dde7e5]
- Updated dependencies [279f80c]
- Updated dependencies [5638ada]
- Updated dependencies [279f80c]
  - @nifrajs/core@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies [92181be]
- Updated dependencies [3773f0a]
- Updated dependencies [92181be]
  - @nifrajs/core@1.10.0

## 1.9.1

### Patch Changes

- 3eb27ae: Internal tidy — remove a dead local variable in the query engine and clean up example wording in doc comments. No API or behavior change.
  - @nifrajs/core@1.9.1

## 1.9.0

### Minor Changes

- 0e1b4cc: Add a full React Query core on `@nifrajs/web-react/query` — `useQuery` (now with `enabled`/`staleTime`),
  `useMutation`, `useInfiniteQuery`, `useQueryClient`, `QueryClientProvider`, and the SSR
  `HydrationBoundary` — a drop-in for the TanStack Query surface, backed by an expanded agnostic engine in
  `@nifrajs/web`.

  The engine (`createQueryClient`) gains imperative cache ops (`getQueryData`/`setQueryData` for optimistic
  updates, `prefetchQuery`), per-query `staleTime`, SSR `dehydrate`/`hydrate`, and paged (`infiniteQuery`)
  support; plus a standalone `createMutation` state machine (single-flight, TanStack callback order). All
  logic lives in the injected-clock, framework-free engine so it's deterministically tested; the React
  bindings are thin `useSyncExternalStore` wrappers. A hook without a `QueryClientProvider` uses a
  client-side singleton (SSR-idle); with a `HydrationBoundary`-fed provider client, queries render their
  server-seeded data during SSR with no hydration flash.

- 6b67833: Add first-class React routing bindings on the new `@nifrajs/web-react/router` subpath — `<Link>`,
  `<NavLink>`, `useNavigate`, `useParams`, `useLocation`, `useSearchParams`, and `<Navigate>` — a
  drop-in replacement for `react-router-dom`'s routing surface over nifra's own file-based router.

  The read hooks are SSR-correct: `@nifrajs/web` now threads the matched route's `params` and the
  request `path` (`pathname + search`) through the render seam (`RenderProps`), and the React adapter's
  `compose` provides them via a `RouterContext` on both the server render and the client mount — so
  `useParams`/`useLocation`/`useSearchParams` return the same value on each side with no hydration
  mismatch. Programmatic navigation flows through a new DOM-free bridge (`getBrowserNavigate` /
  `setBrowserNavigate`, populated by `installHistory`), which also gains history `replace` support, so a
  route component reaches history-aware navigation without importing the browser-only client layer.

### Patch Changes

- Updated dependencies [03cd76f]
- Updated dependencies [03cd76f]
  - @nifrajs/core@1.9.0

## 1.8.0

### Patch Changes

- 1ffd48b: fix(web): the static/client build no longer ships the generated `_nifra-entry.ts` source. `buildClient`
  wrote the client-entry source into the output dir purely as a `Bun.build` entrypoint but never removed it
  after bundling — so `nifra build --target static` leaked the TypeScript source next to the content-hashed
  `_nifra-entry-<hash>.js` the HTML actually references. It's now deleted once the client bundle succeeds; a
  static-build test asserts the `.ts` is absent from the output.
- Updated dependencies [e47c4c5]
  - @nifrajs/core@1.8.0

## 1.7.0

### Minor Changes

- 9f23e90: Fix `nifra build --target static` producing pages that render but never hydrate. The prerender pass hardcoded a placeholder client entry, but the real bundle is content-hashed — so the prerendered HTML's hydration `<script src>` 404'd and every control was inert. `BuildTargetOptions.prerenderApp` is now a factory `(client: BuildManifest) => app` invoked with the completed client build, so the emitted `<script src>` uses the real hashed entry (plus the same styles / route-preload the SSR targets use). A regression test asserts the static HTML references the emitted hashed entry and that the file exists under `/assets`. Breaking only for code calling `buildTarget("static", …)` directly (pass a factory instead of a prebuilt app); `nifra build --target static` users just get working hydration.

### Patch Changes

- Updated dependencies [bd95181]
  - @nifrajs/core@1.7.0

## 1.6.0

### Patch Changes

- @nifrajs/core@1.6.0

## 1.5.0

### Patch Changes

- Updated dependencies [1ac2fde]
- Updated dependencies [bd3433f]
- Updated dependencies [70aa836]
  - @nifrajs/core@1.5.0

## 1.4.0

### Minor Changes

- 4d25970: Add one fail-open request-observation lifecycle shared by tracing, agent telemetry, and DevTools; secured development tooling; contract-based mock responses; validator-neutral schema/route reflection; executable render and storage adapter conformance modules; optional storage pagination/signing/copy capabilities; and metadata-preserving local file storage.

### Patch Changes

- Updated dependencies [4d25970]
  - @nifrajs/core@1.4.0

## 1.3.1

### Patch Changes

- @nifrajs/core@1.3.1

## 1.3.0

### Minor Changes

- 4a4b1c4: feat: `errors` response contract on routes + typed client error bodies

  A route's `RouteSchema` may now declare `errors` — a `{ status → Standard Schema }` map of its failure modes.
  Like `response`, it's a compile-time + introspection contract (not validated at runtime, zero hot-path cost):
  the declared error bodies flow into OpenAPI as non-2xx `responses` and into the `/llms.txt` context, so
  tooling and coding agents can read the _whole_ contract, not just the happy path.

  The **typed client** now surfaces them: on a failure `Result`, `data` is the parsed error body typed from the
  route's `errors` (a union across declared statuses; `unknown` when none declared), discriminated by `ok`.
  `error` remains the normalized `{ error, issues }` summary. The **decoupled contract client**
  (`client(contract, url)`) gets the same treatment — its failure `data` is typed from the op's non-2xx
  `responses` schemas.

  **Behavior change:** on failure, `data` is now the parsed error response body (previously always `null`) — so
  `const { ok, data } = await api.orders.post(...)` gives you the typed error body in the `!ok` branch. `data`
  is still `null` only on a transport error (status `0`, no response).

### Patch Changes

- Updated dependencies [4a4b1c4]
- Updated dependencies [4a4b1c4]
- Updated dependencies [4a4b1c4]
- Updated dependencies [4a4b1c4]
- Updated dependencies [4a4b1c4]
  - @nifrajs/core@1.3.0

## 1.2.2

### Patch Changes

- @nifrajs/core@1.2.2

## 1.2.1

### Patch Changes

- c3ebd73: fix(web): silence the spurious `jsx` "Invalid key" warning at `nifra dev` boot under rolldown-vite

  `@vitejs/plugin-react`'s `react()` returns an ARRAY of plugins, and `nifra.config.ts` lists it as
  `vitePlugins = [react()]`, so the plugin list reaches nifra NESTED (`[[babel, refresh]]`).
  `normalizeRolldownPlugins` — which strips the stale `optimizeDeps.rollupOptions.jsx` key that Vite 8's
  rolldown dep-optimizer rejects — mapped over the outer array without flattening, so it never reached the
  inner `vite:react-babel` plugin that emits the key, and Vite (which flattens plugin arrays itself) then ran
  the un-stripped hook. It now flattens first, so the strip reaches every plugin and the harmless-but-noisy
  `Warning: Invalid input options … "jsx" Invalid key: Expected never but received "jsx"` is gone. No
  behavior change — JSX transform, HMR, and Fast Refresh are unaffected.

  - @nifrajs/core@1.2.1

## 1.2.0

### Patch Changes

- Updated dependencies [0ac2182]
  - @nifrajs/core@1.2.0

## 1.1.0

### Minor Changes

- 37d2383: feat(web): `@nifrajs/web/forms` — typed form ↔ backend-schema binding

  `formFor<typeof backend, "/route">()` binds a form's field names and reads to the route's body schema at
  the type level, derived purely from `typeof backend`. `f.field("text")` (spread onto any framework's
  `<input>`) and `f.read(formData, "text")` are constrained to the body's keys — a typo, an orphan field,
  or a wrong route path becomes a COMPILE error (caught by `nifra check`) instead of a silent runtime
  empty. Framework-agnostic, dependency-free, no schema bundled into the client (the runtime is a trivial
  pass-through; all the work is in the types). It checks the field KEY, not its MEANING.

### Patch Changes

- @nifrajs/core@1.1.0

## 1.0.0

### Patch Changes

- f1f0e18: Context ergonomics, from beta feedback building on Nifra.

  - **`c.json(body, status?)` / `c.text(body, status?)`** — build a `Response` in one line; the second arg is a status number or a full `ResponseInit`, and it works whether you `return` or `throw` it. Ideal for an auth / rate-limit short-circuit from a `derive`/`beforeHandle`: `throw c.json({ error: "unauthorized" }, 401)` instead of `new Response(JSON.stringify(…), { status: 401, headers: … })`. (In a route's happy path keep returning a plain object so the typed client stays in sync.) Added as prototype methods — no per-request allocation.
  - **One name for the request across routes and loaders.** A route handler's `c.req` is now also `c.request`, and a page loader/action's `ctx.request` is now also `ctx.req` — fixing the `c.req`-vs-`ctx.request` mismatch that was easy to trip over.

  Docs: the API page documents `c.json`/`c.text` + the request alias; a new troubleshooting entry covers a `never` typed client (raw-`Response` return, or a non-identity plugin → `defineIdentityPlugin`).

- Updated dependencies [f1f0e18]
- Updated dependencies [3efb7cd]
- Updated dependencies [de9675b]
  - @nifrajs/core@1.0.0

## 1.0.0-beta.4

### Patch Changes

- @nifrajs/core@1.0.0-beta.4

## 1.0.0-beta.3

### Patch Changes

- @nifrajs/core@1.0.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- 5018546: fix(web): built apps now ship their CSS link. `buildServer`/`generateServerManifest` bake the client build's
  stylesheet URLs (`BuildManifest.css` + `routeStyles`) into the server manifest, and the generated server entry
  passes them to `createWebApp` — which already emits `<link rel="stylesheet">` in the SSR `<head>`. Previously the
  head carried the JS modulepreload but no stylesheet, so every built (non-dev) app rendered unstyled. `styles`
  and `routeStyles` are now always exported from the generated manifest (default empty), so hand-written server
  entries can `import { styles, routeStyles } from "./server-manifest"` and forward them too.
  - @nifrajs/core@0.1.0-beta.2
