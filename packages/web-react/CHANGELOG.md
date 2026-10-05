# @nifrajs/web-react

## 4.0.0

### Minor Changes

- af7648c: feat(authjs): official Auth.js integration (backend + client + React bindings)

  New `@nifrajs/authjs` package driving `@auth/core` itself - never a reimplementation of
  the security-critical work:

  - `authjs(config, options?)` mounts `/api/auth/*` (GET + POST) as a type-identity plugin:
    sign-in, OAuth callbacks, session, sign-out, CSRF. Secrets resolve per request
    (explicit → platform binding → `process.env`) and fail loud when missing; `authUrl`
    covers proxy deployments.
  - `getSession(req, config)` (`Session | null`, handlers + loaders) and
    `requireAuthUser(req, config)` (401/redirect guard) mirror the `@nifrajs/better-auth`
    shapes.
  - `@nifrajs/authjs/client` - framework-agnostic `createAuthClient()` (session, sign-in,
    sign-out over the mounted endpoints).
  - `@nifrajs/web-react/auth` - `<AuthSessionProvider>` + `useAuthSession()` (other adapters
    wrap the agnostic client the same way `web-react/i18n` wraps `@nifrajs/i18n`).

- f70f99b: feat(i18n): selectordinal, fallback catalogs, typed nested catalogs and the locale cookie

  The formatter supports `selectordinal` (`{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}`).
  Inside a `plural` or `selectordinal` case, `#` is now the number in the locale's own format
  (`1,000 items`, `1.000 Artikel`) instead of its plain digits - the output changes for counts of 1,000
  and more and for fractions.

  `createFormatter(locale, messages, options)` takes `fallback` catalogs, tried in order for a key the
  catalog lacks (`locales.chain()` gives the order); `onMissing(key, locale)`, called once per key when
  no catalog has it; and `timeZone` and `numberingSystem` defaults for `d()`, `n()` and `#`. An invalid
  locale, time zone or numbering system throws at creation. Formatters are cached per catalog and
  options, with bounded caches, so per-request values cannot grow memory.

  Catalogs may nest: values are messages, lists or blocks, read with dotted keys (`t("home.title")`); a
  flat key that contains a dot is found first, so flat catalogs work unchanged. `get(key)` returns a list
  or block whole. Lookups read own properties only, and an argument named like an `Object.prototype`
  member renders empty unless passed. Declaring `interface Register { messages: typeof en }` on
  `@nifrajs/i18n` types every `t()` and `get()` key, and other locales' catalogs (`Translation`,
  `PartialMessages`) against that shape.

  `localeCookie(name, locale, { maxAge })` returns the `document.cookie` string for a language switcher,
  byte-identical to the `Set-Cookie` `localeDetector({ persist: true })` writes.

  Every adapter's `<I18nProvider>` takes `fallback`, `onMissing`, `timeZone` and `numberingSystem`, and
  its `messages` prop is checked against the registered catalog type.

- 49f106f: feat(i18n): rich text from catalog messages without HTML

  `rich(formatter, key, tags, vars)` from the new `@nifrajs/i18n/rich` entry formats a message like
  `t()` and turns its `<name>…</name>` and `<name/>` tags into calls to `tags[name]`, returning the
  message as text and whatever the handlers returned. Tags are bare names (no attributes); a tag
  without an own handler keeps its content as text, an unclosed or stray marker stays literal, and
  interpolated values and `#` are never read for tags. `renderRich(renderer, ...)` is the same for a
  UI framework.

  React, Preact, Solid and Vue export `rich(t, key, tags, vars)` from `/i18n`, returning one node
  (each handler receives its tag's content as one node, and `<br/>` renders a `<br>` unless `br` is
  given). Svelte exports `<Rich key tags vars>`, which takes one snippet per tag, and `rich()` for the
  parts array. `t()` is unchanged.

- 7e1e1c3: feat(web): `data-nifra-prefetch` picks when a link warms its route: `intent`, `viewport`, `render` or `none`.

  ```html
  <nav data-nifra-prefetch="viewport">
    <a href="/docs/routing">Routing</a>
    <a href="/reports/annual" data-nifra-prefetch="none">Annual report</a>
  </nav>
  ```

  The attribute goes on a link or on any element around it; the nearest one wins. `intent` (the
  default, as before) warms the route's code and loader data on hover or keyboard focus, `viewport`
  once the link scrolls into view, `render` as soon as a page shows it, and `none` never. An unknown
  value is `intent`. `viewport` and `render` links are found when the page loads and whenever the
  router settles (a navigation, a submit); a link the page adds in between warms on intent until
  then. It works under every adapter, and React's `<Link>` and `<NavLink>` take a `prefetch` prop
  that renders it.

  Prefetched data is now used by a click within 30 seconds of arriving; after that the click loads
  the route again. The page already on screen is no longer prefetched. `PrefetchMode` is exported
  from `@nifrajs/web`.

- 0f6babe: feat(web): a route can export a `handle`, and `useMatches()` reports the rendered chain on every adapter.

  ```tsx
  // routes/orgs/[org]/_layout.tsx
  import { useMatches } from "@nifrajs/web-react/router";

  export const handle = { crumb: "Organization" };

  export default function OrgLayout({
    children,
  }: {
    children: React.ReactNode;
  }) {
    const crumbs = useMatches().flatMap(
      (m) => (m.handle as { crumb?: string } | undefined)?.crumb ?? []
    );
    // ...
  }
  ```

  `useMatches()` lists the layouts being rendered, outermost first, then the page, each as
  `{ id, pathname, params, data, handle }`: the route file without its extension, the part of the URL
  it covers (never the query), the params it declares, its loader data (`null` without a loader), and
  its `handle` export. The server render and the browser report the same list, so a breadcrumb trail
  hydrates with no mismatch. `handle` is read from the module on each side and never serialized.

  While a `_loading` page is up it takes the page's place; a nested `_404` reports the layouts it
  renders inside; an `_error` page the server renders reports an empty list. The hook ships from each
  adapter's `/router` entry: an array on React and Preact, a `Ref` on Vue, an accessor on Solid and
  Svelte. An app that never calls it does not bundle it.

  The Preact, Solid, Vue and Svelte client mounts now pass `params` and `path` to the rendered chain,
  as the server render already did. `UIMatch` and `MatchChain` are exported from `@nifrajs/web`.

### Patch Changes

- 65f2d4b: `createAuthClient().signIn()` works with Auth.js v5, which refuses a `GET` to `/signin/:provider`. It now fetches a CSRF token, submits the sign-in as a `POST`, and navigates to the provider page Auth.js answers with (any `http(s)` address; anything else lands on `/`). `signIn()` therefore returns a `Promise<void>`, and so does `useAuthSession().signIn`. `signInUrl()` is deprecated: it names a URL Auth.js v5 only accepts as a CSRF-carrying `POST`.
- ee19d29: fix(web-react, web-preact, web-vue, web-solid, web-svelte): a layout keeps its loader data in the
  browser. The mounted router rendered every layout with `data: null` - on the first paint, where the
  server had rendered the layout with its data and the client render no longer matched it, and after
  each client navigation. It now hands each layout the data the router holds for it. On Solid a layout
  also follows a same-route update, so new layout data after a revalidation or a param change arrives
  without the layout remounting.
- 3442e1c: feat(web): `export const ssr = false` keeps a page's component off the server. The route is still
  matched, its layouts still render, its gates and loader still run and the data is still embedded;
  the server puts the page's `HydrateFallback` export in the page slot - or nothing - and the browser
  hydrates that before it renders the component with the data it already has. A client navigation to
  the page renders the component directly. `HydrateFallback` receives the component's props. The
  module is still imported on the server for its loader and options, so an import that needs a
  browser at load time belongs inside the component. `ssr = false` together with `hydrate = false`
  is refused when the page is rendered: nothing would render it. On Solid the layouts mount again
  when the component takes over from the fallback, as they do on any Solid route change.

  `assertRenderAdapterConformance` now also renders a chain whose leaf is a function returning
  `null` and requires the layouts around an empty page slot (check `"empty leaf"`). An adapter that
  cannot render such a leaf fails conformance.

  fix(web-react): the mounted router hydrates against the state it was mounted with. A router that
  changed before React reached the component - a client loader that answered first - no longer
  hydrates a tree the server markup never had; React renders the newer state right after.

- 000c1a0: `<AuthSessionProvider>` follows its `initialSession` prop after mount: a new seed, such as a loader re-run on navigation, replaces the provider's session and status as a remount would. Re-rendering with the same seed keeps a session changed since, for example by `signOut()`.
- 1a9e804: `useAuthSession().signOut()` leaves the `<AuthSessionProvider>` subtree unauthenticated once the server has ended the session, including with `redirect: false`, where the page stays and used to go on showing the signed-out user's session. A sign-out the server refuses keeps the session.
- e70d33c: fix(web-react): a render that hits two copies of React says so. When a component's hooks come from a
  different React than the one `react-dom/server` renders with (often a linked package's own
  `node_modules`), SSR failed with the engine's raw null-dispatcher `TypeError`. It now fails with
  `[nifra/web-react] a component called a React hook with no dispatcher`, naming the duplicate and the
  fix, with the original error kept as `cause`.
- 64e7a42: fix(web): pages that `defer()` keep working under a nonce Content-Security-Policy.
  React, Solid and Preact stream inline scripts to reveal a Suspense boundary that resolves after the
  shell, and none of them carried the document's nonce, so a nonce CSP blocked them and the boundary
  stayed on its fallback. `RenderAdapter.renderToStream` now receives `{ nonce }` as an optional third
  argument (`RenderStreamOptions`), and every adapter that streams scripts applies it: React and Solid
  through their own `nonce` option, Preact on the one island-runtime script it streams. A script the
  app renders itself never inherits the nonce. Vue, Svelte and the vanilla adapter stream no scripts.
- Updated dependencies [65f2d4b]
- Updated dependencies [d8c2a35]
- Updated dependencies [af7648c]
- Updated dependencies [dde125b]
- Updated dependencies [22e2af8]
- Updated dependencies [72b62fa]
- Updated dependencies [aa44e93]
- Updated dependencies [4a3ee60]
- Updated dependencies [963694f]
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
- Updated dependencies [86e2d0f]
- Updated dependencies [a0cfffa]
- Updated dependencies [d7892ea]
- Updated dependencies [93e5e7f]
- Updated dependencies [214d674]
- Updated dependencies [4936309]
- Updated dependencies [ff5a779]
- Updated dependencies [772249a]
- Updated dependencies [f70f99b]
- Updated dependencies [49f106f]
- Updated dependencies [4936309]
- Updated dependencies [def0172]
- Updated dependencies [fc2f019]
- Updated dependencies [a734fba]
- Updated dependencies [0e9b167]
- Updated dependencies [bbdc5a1]
- Updated dependencies [10bc446]
- Updated dependencies [e8270d9]
- Updated dependencies [d942c33]
- Updated dependencies [ef28ef9]
- Updated dependencies [ff4a062]
- Updated dependencies [43ba944]
- Updated dependencies [46c741a]
- Updated dependencies [7bfa25e]
- Updated dependencies [216fe27]
- Updated dependencies [4936309]
- Updated dependencies [6e257a6]
- Updated dependencies [4a03d30]
- Updated dependencies [8e30090]
- Updated dependencies [28f3aaf]
- Updated dependencies [6d20355]
- Updated dependencies [08250bf]
- Updated dependencies [6907cbe]
- Updated dependencies [4b8d8de]
- Updated dependencies [ba5dd1c]
- Updated dependencies [d50f73e]
- Updated dependencies [031c33d]
- Updated dependencies [8fa902c]
- Updated dependencies [085e852]
- Updated dependencies [0dac7ec]
- Updated dependencies [b64c3ee]
- Updated dependencies [dc2d4d3]
- Updated dependencies [bda9637]
- Updated dependencies [81c720e]
- Updated dependencies [ed60b23]
- Updated dependencies [0150ed4]
- Updated dependencies [ae815ab]
- Updated dependencies [ea2ee87]
- Updated dependencies [3442e1c]
- Updated dependencies [85d636b]
- Updated dependencies [6c978a1]
- Updated dependencies [bfe29b6]
- Updated dependencies [8b99424]
- Updated dependencies [87783f0]
- Updated dependencies [135aba4]
- Updated dependencies [47b0d65]
- Updated dependencies [e32268d]
- Updated dependencies [432fec3]
- Updated dependencies [0e14068]
- Updated dependencies [8f1b780]
- Updated dependencies [dcc9ff6]
- Updated dependencies [5a63dd4]
- Updated dependencies [c49882f]
- Updated dependencies [dfd19d8]
- Updated dependencies [28e091f]
- Updated dependencies [046e79d]
- Updated dependencies [6393b1e]
- Updated dependencies [a158b74]
- Updated dependencies [ee19d29]
- Updated dependencies [293d3c8]
- Updated dependencies [7e1e1c3]
- Updated dependencies [0cd5f6e]
- Updated dependencies [2245bee]
- Updated dependencies [feeec4a]
- Updated dependencies [3eb6339]
- Updated dependencies [f784c32]
- Updated dependencies [e3b2b97]
- Updated dependencies [5934b5d]
- Updated dependencies [03a3729]
- Updated dependencies [bd11269]
- Updated dependencies [579d9a9]
- Updated dependencies [3554ad8]
- Updated dependencies [64e7a42]
- Updated dependencies [ee19d29]
- Updated dependencies [d6f806f]
- Updated dependencies [38cf032]
- Updated dependencies [b94e5cb]
- Updated dependencies [0f6babe]
- Updated dependencies [00f18bf]
- Updated dependencies [a84f546]
- Updated dependencies [669b6a2]
- Updated dependencies [ff25d68]
  - @nifrajs/authjs@4.0.0
  - @nifrajs/core@4.0.0
  - @nifrajs/web@4.0.0
  - @nifrajs/i18n@4.0.0
  - @nifrajs/image@4.0.0

## 3.5.0

### Patch Changes

- Updated dependencies [6046984]
- Updated dependencies [ac27343]
- Updated dependencies [d5b7c22]
  - @nifrajs/core@3.5.0
  - @nifrajs/web@3.5.0
  - @nifrajs/image@3.5.0
  - @nifrajs/i18n@3.5.0

## 3.4.0

### Patch Changes

- 8d23613: Add the opt-in `@nifrajs/webmcp` package: typed WebMCP registration, core-backed receipts, deterministic predictive-UI reconciliation, and host-independent conformance checks. Also tighten agent execution cancellation cleanup so aborted local work cannot leak into later turns.
- Updated dependencies [8d23613]
- Updated dependencies [8d23613]
- Updated dependencies
- Updated dependencies [719d82e]
  - @nifrajs/web@3.4.0
  - @nifrajs/core@3.4.0
  - @nifrajs/i18n@3.4.0
  - @nifrajs/image@3.4.0

## 3.3.0

### Patch Changes

- @nifrajs/core@3.3.0
- @nifrajs/i18n@3.3.0
- @nifrajs/image@3.3.0
- @nifrajs/web@3.3.0

## 3.2.0

### Patch Changes

- f34a050: Record the pending source changes for these packages in their release notes so fixed-version publishing does not omit their changelog entries.
- Updated dependencies [652201a]
- Updated dependencies [3aefb12]
- Updated dependencies [8b58d1f]
- Updated dependencies [c4ed8f7]
- Updated dependencies [25305bb]
- Updated dependencies [095c320]
- Updated dependencies [7504864]
- Updated dependencies [e88c23a]
- Updated dependencies [c39712e]
- Updated dependencies [9010fd3]
- Updated dependencies [7551709]
- Updated dependencies [ea2356e]
- Updated dependencies [a816b87]
  - @nifrajs/web@3.2.0
  - @nifrajs/core@3.2.0
  - @nifrajs/image@3.2.0
  - @nifrajs/i18n@3.2.0

## 3.1.0

### Patch Changes

- 8b136ee: Framework bindings now share consistent query and fetcher idle behavior while keeping mounted-router state isolated per adapter.
- Updated dependencies [5b78473]
- Updated dependencies [1400f6c]
- Updated dependencies [8b136ee]
- Updated dependencies [a7db515]
  - @nifrajs/core@3.1.0
  - @nifrajs/i18n@3.1.0
  - @nifrajs/web@3.1.0
  - @nifrajs/image@3.1.0

## 3.0.0

### Patch Changes

- 86a555b: The roadmap contract surfaces are now shipped across the public packages: shared island triggers,
  typed content indexes and joins, client loader/action hooks, and unified static, dynamic, and
  intercepting boundary modes. WebSocket routes also support opt-in synchronous outbound validation
  through `sendSchema` + `validateSend`; invalid or asynchronous outbound frames fail closed while the
  default remains type-level only.
- Updated dependencies [f3d2a35]
- Updated dependencies [6e43c15]
- Updated dependencies [293a7fe]
- Updated dependencies [485ae60]
- Updated dependencies [627b0ba]
- Updated dependencies [f0fd370]
- Updated dependencies [004deee]
- Updated dependencies [86a555b]
- Updated dependencies [8c5f4cf]
- Updated dependencies [f0fd370]
- Updated dependencies [381bbf3]
- Updated dependencies [36801ae]
- Updated dependencies [9acadba]
- Updated dependencies [99fc683]
- Updated dependencies [73d894d]
  - @nifrajs/core@3.0.0
  - @nifrajs/web@3.0.0
  - @nifrajs/i18n@3.0.0
  - @nifrajs/image@3.0.0

## 2.14.1

### Patch Changes

- Updated dependencies [bf93902]
  - @nifrajs/core@2.14.1
  - @nifrajs/i18n@2.14.1
  - @nifrajs/web@2.14.1
  - @nifrajs/image@2.14.1

## 2.14.0

### Patch Changes

- Updated dependencies [489c6b6]
- Updated dependencies [701961a]
- Updated dependencies [62e22e2]
- Updated dependencies [62e22e2]
- Updated dependencies [62133bf]
- Updated dependencies [8dffdf4]
- Updated dependencies [489c6b6]
  - @nifrajs/web@2.14.0
  - @nifrajs/core@2.14.0
  - @nifrajs/i18n@2.14.0
  - @nifrajs/image@2.14.0

## 2.13.0

### Patch Changes

- Updated dependencies [e0b2dd6]
- Updated dependencies [7535ce1]
- Updated dependencies [1704308]
- Updated dependencies [6510fdc]
  - @nifrajs/core@2.13.0
  - @nifrajs/web@2.13.0
  - @nifrajs/i18n@2.13.0
  - @nifrajs/image@2.13.0

## 2.12.1

### Patch Changes

- Updated dependencies [fba30c7]
  - @nifrajs/core@2.12.1
  - @nifrajs/i18n@2.12.1
  - @nifrajs/web@2.12.1
  - @nifrajs/image@2.12.1

## 2.12.0

### Patch Changes

- a5d3f5b: Add stable diagnostic codes, application-supplied rule packs, fix recipes, assurance bundles, contract lock snapshots, hydration assurance hooks, replay metadata, security verification rules, and idempotency proofs.
- Updated dependencies [df100d3]
- Updated dependencies [0efacea]
- Updated dependencies [cd1732c]
- Updated dependencies [df100d3]
- Updated dependencies [9a9346e]
- Updated dependencies [b5f47c0]
- Updated dependencies [fc33c0f]
- Updated dependencies [fa51aba]
- Updated dependencies [c4e8bb0]
- Updated dependencies [11d1658]
- Updated dependencies [33ee9ff]
- Updated dependencies [ceda72d]
- Updated dependencies [2c004ca]
- Updated dependencies [5f71c23]
- Updated dependencies [3788b36]
- Updated dependencies [0863ef0]
- Updated dependencies [ae5338f]
- Updated dependencies [8847825]
- Updated dependencies [9a9346e]
- Updated dependencies [4c2123d]
- Updated dependencies [5e4e31a]
- Updated dependencies [24f1787]
- Updated dependencies [9a9346e]
- Updated dependencies [b045f9e]
- Updated dependencies [df07059]
- Updated dependencies [9a9346e]
- Updated dependencies [9a9346e]
- Updated dependencies [dbc0b79]
- Updated dependencies [bd5c624]
- Updated dependencies [a5d3f5b]
- Updated dependencies [00819c5]
- Updated dependencies [e2bdd4a]
- Updated dependencies [e2d1939]
- Updated dependencies [e83e6eb]
- Updated dependencies [64d25db]
- Updated dependencies [c55f7a3]
- Updated dependencies [f8b0097]
  - @nifrajs/core@2.12.0
  - @nifrajs/i18n@2.12.0
  - @nifrajs/web@2.12.0
  - @nifrajs/image@2.12.0

## 2.11.0

### Patch Changes

- Updated dependencies [ed5e91c]
- Updated dependencies [30f5ea3]
- Updated dependencies [c29e0d0]
  - @nifrajs/web@2.11.0
  - @nifrajs/core@2.11.0
  - @nifrajs/i18n@2.11.0
  - @nifrajs/image@2.11.0

## 2.10.0

### Patch Changes

- Updated dependencies [5263c4e]
- Updated dependencies [15bffdd]
- Updated dependencies [15bffdd]
- Updated dependencies [15bffdd]
  - @nifrajs/web@2.10.0
  - @nifrajs/core@2.10.0
  - @nifrajs/image@2.10.0
  - @nifrajs/i18n@2.10.0

## 2.9.1

### Patch Changes

- Updated dependencies [01e36fb]
  - @nifrajs/core@2.9.1
  - @nifrajs/web@2.9.1
  - @nifrajs/i18n@2.9.1
  - @nifrajs/image@2.9.1

## 2.9.0

### Patch Changes

- Updated dependencies [e05e56d]
  - @nifrajs/core@2.9.0
  - @nifrajs/web@2.9.0
  - @nifrajs/i18n@2.9.0
  - @nifrajs/image@2.9.0

## 2.8.2

### Patch Changes

- Updated dependencies [f7d68e8]
  - @nifrajs/core@2.8.2
  - @nifrajs/image@2.8.2
  - @nifrajs/web@2.8.2
  - @nifrajs/i18n@2.8.2

## 2.8.1

### Patch Changes

- Updated dependencies [78d66a4]
- Updated dependencies [93fdc89]
  - @nifrajs/core@2.8.1
  - @nifrajs/web@2.8.1
  - @nifrajs/i18n@2.8.1
  - @nifrajs/image@2.8.1

## 2.8.0

### Patch Changes

- Updated dependencies [118e4a5]
  - @nifrajs/web@2.8.0
  - @nifrajs/core@2.8.0
  - @nifrajs/i18n@2.8.0
  - @nifrajs/image@2.8.0

## 2.7.1

### Patch Changes

- 322cc2b: SSR `react-dom/server` resolution now also detects a bundled server that was built without `nifra build` (a hand-rolled `bun build --target bun` carries no bundle marker): inside any bundle the adapter uses the bundle's own inlined, deduped react-dom instead of re-importing a second copy from disk. That second copy could crash hook-using components (two React cores) or, hook-free, silently render with development React when the runtime `NODE_ENV` was unset - an SSR slowdown that looked like a runtime regression. The SSR benchmark's Bun row builds with the same bundle marker `nifra build` stamps, so it measures production React.
- Updated dependencies [52c89e0]
  - @nifrajs/core@2.7.1
  - @nifrajs/web@2.7.1
  - @nifrajs/i18n@2.7.1
  - @nifrajs/image@2.7.1

## 2.7.0

### Patch Changes

- @nifrajs/core@2.7.0
- @nifrajs/i18n@2.7.0
- @nifrajs/image@2.7.0
- @nifrajs/web@2.7.0

## 2.6.1

### Patch Changes

- Updated dependencies [5840c98]
- Updated dependencies [80419f5]
  - @nifrajs/core@2.6.1
  - @nifrajs/web@2.6.1
  - @nifrajs/i18n@2.6.1
  - @nifrajs/image@2.6.1

## 2.6.0

### Patch Changes

- Updated dependencies [e6349e5]
- Updated dependencies [08fe221]
- Updated dependencies [8383063]
  - @nifrajs/web@2.6.0
  - @nifrajs/core@2.6.0
  - @nifrajs/i18n@2.6.0
  - @nifrajs/image@2.6.0

## 2.5.0

### Patch Changes

- 02d9aa8: Routing hooks now SSR-render correctly on the dev server. In dev, the adapter is imported by Bun while route modules load through Vite's SSR runner, so the router module could be evaluated twice in one process - two context objects, and `useSearch`/`useParams`/`useLocation` read a context the render never provided. The result was hooks SSR-rendering their empty defaults (`useSearch()` gave `{}`) while the same request's loader saw the validated values; hydration then papered over it on the client, so it surfaced as "the search schema doesn't work in dev". The router context in every adapter is now a `globalThis` singleton (keyed by `Symbol.for`), so both evaluations share the one context React/Vue/Solid/Preact matches providers to readers by. The Vite dev server also mirrors its client `resolve.conditions` into `ssr.resolve.{conditions,externalConditions}`, so dev SSR resolves the same `bun`-conditioned source files Bun does instead of a package's `dist` artifact - which nothing in the dev loop rebuilds, and whose staleness previously 500'd inside framework code.
- Updated dependencies [02d9aa8]
  - @nifrajs/web@2.5.0
  - @nifrajs/core@2.5.0
  - @nifrajs/i18n@2.5.0
  - @nifrajs/image@2.5.0

## 2.4.0

### Patch Changes

- Updated dependencies [1c2bf5a]
- Updated dependencies [138bfba]
- Updated dependencies [23e6eb1]
  - @nifrajs/web@2.4.0
  - @nifrajs/core@2.4.0
  - @nifrajs/i18n@2.4.0
  - @nifrajs/image@2.4.0

## 2.3.0

### Minor Changes

- c823915: Typed, validated search params: a route declares a `searchSchema` and both its loader and its component read the parsed, validated query.

  Export a Standard Schema as `searchSchema` from a route. The loader's `ctx.search` becomes the parsed URL query validated against it (typed via `LoaderArgs<typeof app, Env, typeof searchSchema>`), and the component reads the same value with `useSearch<typeof searchSchema>()`. Invalid or hostile input fails closed to the schema's defaults (never a 500); without a `searchSchema`, both are the raw parsed query. Validation runs at match time and the value is derived identically on the server and on client navigation, so a component never parses `window.location.search` by hand and the query it renders hydrates with no mismatch.

  ```tsx
  export const searchSchema = v.object({
    page: v.optional(v.fallback(v.number(), 1), 1),
  });

  export async function loader({
    search,
    api,
  }: LoaderArgs<typeof backend, unknown, typeof searchSchema>) {
    return { rows: await api.reports.list(search).get() }; // search.page is a number
  }

  export default function Reports({ data }) {
    const { page } = useSearch<typeof searchSchema>(); // page: number, SSR-correct
    return <Pager page={page} />;
  }
  ```

  A `_layout` can declare its own `searchSchema` for keys shared across a section (`?org`, `?theme`); the route's effective search merges the layout chain's schemas with the page's, page-wins on a conflict, so both the layout and the page read their validated slice from one object.

  A route can also list `searchClientKeys` - search keys that are purely client-side UI (`?tab`, a client-side `?sort`, `?modal`). When a client navigation changes only those keys, the URL updates (so `useSearch` re-renders) without re-running the loader; any other key change revalidates as before, so data is never stale.

  `useSearch` ships on every adapter - React (a value), Preact (a value), Vue (a `Ref`), Solid (an `Accessor`), and Svelte (an accessor), each in that framework's own shape.

  `navigate` gains an object form on every adapter: `navigate({ to, search, replace })` serializes `search` onto `to` (no hand-built query strings). Run `nifra sync-routes` to generate `nifra-routes.d.ts` (each static route mapped to its schema output) and include it in your tsconfig, and `search` is typed against the target route's `searchSchema` - a wrong shape for a known route is a compile error, while an unmapped path takes a loose `search`. Regenerated from the route files, so a stale shape becomes a `tsc` error. The string-path and history-delta forms are unchanged.

  ```ts
  navigate({ to: "/reports", search: { page: 2 } }); // search typed against /reports's schema
  ```

- 62a8d03: Add `useServerFn` - a server function's pending, data and error state - to all five adapters.

  ```tsx
  const addTodo = useServerFn(fns.addTodo)
  <button disabled={addTodo.pending} onClick={() => addTodo.call({ text }).catch(() => {})}>add</button>
  ```

  Calling a server function never needed a binding: the client stub is `(input) => Promise<Output>`.
  This adds only the state a component wants around it.

  The state machine is `@nifrajs/web`'s `createServerFnStore`, shared by every adapter, so "is it
  pending" has one answer rather than five that drift. Each binding contributes just its subscription
  primitive: `useSyncExternalStore` (React, Preact), a signal (Solid), a `shallowRef` (Vue), a `readable`
  (Svelte).

  Two behaviours worth knowing:

  - **The last call wins.** A response that is no longer the newest is discarded rather than written, so
    a slow first call landing after a fast second cannot overwrite fresh data with stale.
  - **`call` still rejects.** The error is recorded for rendering AND the promise rejects, so `await`
    behaves normally. A caller that only renders from state should attach `.catch(() => {})`, as with
    `useFetcher`'s `submit`.

  `data` is kept while the next call is in flight, so a rendered list does not blank on every refetch.

- dcacfe7: Guard navigation away from unsaved work with `useBlocker`.

  Mirrors react-router's shape: pass a boolean or a `({ currentLocation, nextLocation }) => boolean`
  predicate and get back `{ state, proceed, reset }`. When a navigation is intercepted - a `<Link>` or
  anchor click, `useNavigate`, or a browser back/forward - `state` becomes `"blocked"`, so you render
  your OWN confirmation and call `proceed()` to continue or `reset()` to stay. A plain boolean can't
  express an async "are you sure?"; these two callbacks can.

  ```tsx
  import { useBlocker } from "@nifrajs/web-react/router";

  const blocker = useBlocker(form.isDirty);

  return blocker.state === "blocked" ? (
    <ConfirmDialog onConfirm={blocker.proceed} onCancel={blocker.reset} />
  ) : null;
  ```

  Back and forward are guarded too: the destination URL is restored before you are asked, so the page
  never changes underneath the prompt. It also arms the browser's native "Leave site?" prompt on tab
  close and reload. Idle on the server and before hydration, so it degrades to native navigation and
  stays hydration-safe.

### Patch Changes

- ea0a27f: A server function has one type per half, so both the server call and the hook argument are honest.

  ```ts
  export type ClientServerFn<Input, Output> = (
    input: Input
  ) => MaybePromise<Output>;
  export type ServerFnReference<Input, Output> =
    | ServerFn<Input, Output>
    | ClientServerFn<Input, Output>;
  ```

  One type could not describe both halves. `ServerFn` is the SERVER declaration and takes `(input,
context)`; the client imports a generated stub that takes one argument. Widening the single type so a
  one-argument call compiled made a direct server call type-check while handing the declaration
  `undefined` for a context its implementation requires - a runtime failure the compiler had just been
  told to allow.

  Now the two are separate and `useServerFn` accepts either through `ServerFnReference`, which is the
  one place the two halves legitimately meet. Calling a declaration from your own server code needs the
  context, and omitting it is a compile error again.

- Updated dependencies [6f5b3ad]
- Updated dependencies [85b354d]
- Updated dependencies [7293a1c]
- Updated dependencies [8514caa]
- Updated dependencies [ea0a27f]
- Updated dependencies [ea0a27f]
- Updated dependencies [45b0733]
- Updated dependencies [c42d777]
- Updated dependencies [ea0a27f]
- Updated dependencies [b271164]
- Updated dependencies [8c77d47]
- Updated dependencies [ea0a27f]
- Updated dependencies [ea0a27f]
- Updated dependencies [d190b1c]
- Updated dependencies [a4ecca9]
- Updated dependencies [de8d992]
- Updated dependencies [a92104e]
- Updated dependencies [5fe332a]
- Updated dependencies [c823915]
- Updated dependencies [d2840ac]
- Updated dependencies [62a8d03]
- Updated dependencies [dcacfe7]
- Updated dependencies [28704d7]
- Updated dependencies [ea0a27f]
- Updated dependencies [0c2de22]
  - @nifrajs/core@2.3.0
  - @nifrajs/web@2.3.0
  - @nifrajs/i18n@2.3.0
  - @nifrajs/image@2.3.0

## 2.2.0

### Minor Changes

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
    return { org: await findOrg(params.org) }    // params is { org } - nothing deeper
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

### Patch Changes

- 1f52a12: Catch a duplicate React reaching SSR with both paths, instead of a null-dispatcher crash.

  The adapter already re-roots `react-dom/server` to the app so it shares the route components' React. That
  fixes the common case but cannot guarantee the last mile: a `react` nested under react-dom, or a
  components tree resolving `react` elsewhere, still puts two React cores in the render. Two cores is two
  hook dispatchers, and SSR throws `resolveDispatcher().useState is null` from deep inside react-dom-server

  - a message that names a React internal and nothing about the two directories that caused it, from which
    the real fix is hours of inference.

  After re-rooting, the adapter now compares the realpath of the `react` react-dom will render with against
  the `react` the components import, and if they differ throws naming both paths and the fix. `nifra doctor`
  checks what is installed; this checks what SSR actually resolved, which is the only thing that can catch a
  duplicate the two dev pipelines introduce (Bun resolves SSR, Vite the client) rather than the install - a
  Vite `resolve.dedupe` or alias fixes only the client bundle, never this path. Silent on the single-copy
  common case, and it never manufactures a failure: a `react` it cannot resolve on either side is not
  evidence of a duplicate. Runs once, under the unbundled Bun runtime only, so bundled and non-Bun outputs
  are untouched.

- Updated dependencies [39b1670]
- Updated dependencies [d428f52]
- Updated dependencies [135d0c6]
- Updated dependencies [5f460db]
- Updated dependencies [1394641]
- Updated dependencies [e713cab]
- Updated dependencies [a4645e2]
- Updated dependencies [a7d740a]
- Updated dependencies [6e996a1]
- Updated dependencies [15ad6ca]
- Updated dependencies [6aa0aac]
- Updated dependencies [1857d39]
- Updated dependencies [6ba3173]
- Updated dependencies [ca71a2e]
- Updated dependencies [0fc215b]
- Updated dependencies [2ff661f]
- Updated dependencies [a1327a4]
- Updated dependencies [2500705]
  - @nifrajs/web@2.2.0
  - @nifrajs/core@2.2.0
  - @nifrajs/i18n@2.2.0
  - @nifrajs/image@2.2.0

## 2.1.0

### Patch Changes

- Updated dependencies [bd294bb]
- Updated dependencies [d3aac63]
  - @nifrajs/core@2.1.0
  - @nifrajs/web@2.1.0
  - @nifrajs/i18n@2.1.0
  - @nifrajs/image@2.1.0

## 2.0.0

### Minor Changes

- a7d34e5: Navigation loading UI for `@nifrajs/web-react/router`, plus a per-link pending signal.

  nifra navigates imperatively - it fetches the next route's chunk and loader data while the current route stays on screen, then swaps - so a route transition is signalled by the router's `pending` flag, not a Suspense boundary.

  - `useNavigation()` returns `{ pending, state: "idle" | "loading", location }` (Remix-shaped); `location` is the `pathname + search` being navigated to while pending. `usePending()` is the boolean form.
  - `NavLink`'s render-prop `isPending` is now real: it is `true` while a navigation to that link's own target is in flight (matched like `isActive`), so a link can show its own spinner. Previously always `false`.
  - The agnostic router now publishes `pendingPath` (the navigation target) on its state while `pending`, and `compose` threads `pending`/`pendingPath` into the router context. Both are `false`/absent on the server and the initial client render, so they are hydration-safe.

### Patch Changes

- Updated dependencies [a7b1d60]
- Updated dependencies [eaac3d7]
- Updated dependencies [ade0c7a]
- Updated dependencies [82676e0]
- Updated dependencies [1522d06]
- Updated dependencies [d91a45b]
- Updated dependencies [d91a45b]
- Updated dependencies [e97a92f]
- Updated dependencies [a7b1d60]
- Updated dependencies [e8e49d1]
- Updated dependencies [a7d34e5]
- Updated dependencies [a7b1d60]
  - @nifrajs/core@2.0.0
  - @nifrajs/web@2.0.0
  - @nifrajs/i18n@2.0.0
  - @nifrajs/image@2.0.0

## 1.13.0

### Patch Changes

- Updated dependencies [aae8614]
- Updated dependencies [5b6127a]
  - @nifrajs/core@1.13.0
  - @nifrajs/web@1.13.0
  - @nifrajs/i18n@1.13.0
  - @nifrajs/image@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies [63d3845]
- Updated dependencies [246f498]
  - @nifrajs/core@1.12.0
  - @nifrajs/web@1.12.0
  - @nifrajs/i18n@1.12.0
  - @nifrajs/image@1.12.0

## 1.11.0

### Patch Changes

- Updated dependencies [2dde7e5]
- Updated dependencies [279f80c]
- Updated dependencies [5638ada]
- Updated dependencies [279f80c]
  - @nifrajs/core@1.11.0
  - @nifrajs/web@1.11.0
  - @nifrajs/i18n@1.11.0
  - @nifrajs/image@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies [92181be]
- Updated dependencies [3773f0a]
- Updated dependencies [92181be]
  - @nifrajs/core@1.10.0
  - @nifrajs/web@1.10.0
  - @nifrajs/i18n@1.10.0
  - @nifrajs/image@1.10.0

## 1.9.1

### Patch Changes

- 3eb27ae: Tidy the `@nifrajs/web-react/query` module documentation comment. Docs only - no API or behavior change.
- Updated dependencies [3eb27ae]
  - @nifrajs/web@1.9.1
  - @nifrajs/core@1.9.1
  - @nifrajs/i18n@1.9.1
  - @nifrajs/image@1.9.1

## 1.9.0

### Minor Changes

- 0e1b4cc: Add a full React Query core on `@nifrajs/web-react/query` - `useQuery` (now with `enabled`/`staleTime`),
  `useMutation`, `useInfiniteQuery`, `useQueryClient`, `QueryClientProvider`, and the SSR
  `HydrationBoundary` - a drop-in for the TanStack Query surface, backed by an expanded agnostic engine in
  `@nifrajs/web`.

  The engine (`createQueryClient`) gains imperative cache ops (`getQueryData`/`setQueryData` for optimistic
  updates, `prefetchQuery`), per-query `staleTime`, SSR `dehydrate`/`hydrate`, and paged (`infiniteQuery`)
  support; plus a standalone `createMutation` state machine (single-flight, TanStack callback order). All
  logic lives in the injected-clock, framework-free engine so it's deterministically tested; the React
  bindings are thin `useSyncExternalStore` wrappers. A hook without a `QueryClientProvider` uses a
  client-side singleton (SSR-idle); with a `HydrationBoundary`-fed provider client, queries render their
  server-seeded data during SSR with no hydration flash.

- 6b67833: Add first-class React routing bindings on the new `@nifrajs/web-react/router` subpath - `<Link>`,
  `<NavLink>`, `useNavigate`, `useParams`, `useLocation`, `useSearchParams`, and `<Navigate>` - a
  drop-in replacement for `react-router-dom`'s routing surface over nifra's own file-based router.

  The read hooks are SSR-correct: `@nifrajs/web` now threads the matched route's `params` and the
  request `path` (`pathname + search`) through the render seam (`RenderProps`), and the React adapter's
  `compose` provides them via a `RouterContext` on both the server render and the client mount - so
  `useParams`/`useLocation`/`useSearchParams` return the same value on each side with no hydration
  mismatch. Programmatic navigation flows through a new DOM-free bridge (`getBrowserNavigate` /
  `setBrowserNavigate`, populated by `installHistory`), which also gains history `replace` support, so a
  route component reaches history-aware navigation without importing the browser-only client layer.

### Patch Changes

- Updated dependencies [03cd76f]
- Updated dependencies [0e1b4cc]
- Updated dependencies [6b67833]
- Updated dependencies [03cd76f]
  - @nifrajs/core@1.9.0
  - @nifrajs/web@1.9.0
  - @nifrajs/i18n@1.9.0
  - @nifrajs/image@1.9.0

## 1.8.0

### Patch Changes

- Updated dependencies [e47c4c5]
- Updated dependencies [1ffd48b]
  - @nifrajs/core@1.8.0
  - @nifrajs/web@1.8.0
  - @nifrajs/i18n@1.8.0
  - @nifrajs/image@1.8.0

## 1.7.0

### Patch Changes

- Updated dependencies [bd95181]
- Updated dependencies [9f23e90]
  - @nifrajs/core@1.7.0
  - @nifrajs/web@1.7.0
  - @nifrajs/i18n@1.7.0
  - @nifrajs/image@1.7.0

## 1.6.0

### Patch Changes

- @nifrajs/core@1.6.0
- @nifrajs/i18n@1.6.0
- @nifrajs/image@1.6.0
- @nifrajs/web@1.6.0

## 1.5.0

### Patch Changes

- Updated dependencies [1ac2fde]
- Updated dependencies [bd3433f]
- Updated dependencies [70aa836]
  - @nifrajs/core@1.5.0
  - @nifrajs/web@1.5.0
  - @nifrajs/i18n@1.5.0
  - @nifrajs/image@1.5.0

## 1.4.0

### Minor Changes

- 4d25970: Add one fail-open request-observation lifecycle shared by tracing, agent telemetry, and DevTools; secured development tooling; contract-based mock responses; validator-neutral schema/route reflection; executable render and storage adapter conformance modules; optional storage pagination/signing/copy capabilities; and metadata-preserving local file storage.

### Patch Changes

- Updated dependencies [4d25970]
  - @nifrajs/core@1.4.0
  - @nifrajs/web@1.4.0
  - @nifrajs/i18n@1.4.0
  - @nifrajs/image@1.4.0

## 1.3.1

### Patch Changes

- @nifrajs/i18n@1.3.1
- @nifrajs/image@1.3.1
- @nifrajs/web@1.3.1

## 1.3.0

### Patch Changes

- Updated dependencies [4a4b1c4]
  - @nifrajs/web@1.3.0
  - @nifrajs/i18n@1.3.0
  - @nifrajs/image@1.3.0

## 1.2.2

### Patch Changes

- @nifrajs/i18n@1.2.2
- @nifrajs/image@1.2.2
- @nifrajs/web@1.2.2

## 1.2.1

### Patch Changes

- Updated dependencies [c3ebd73]
  - @nifrajs/web@1.2.1
  - @nifrajs/i18n@1.2.1
  - @nifrajs/image@1.2.1

## 1.2.0

### Patch Changes

- @nifrajs/web@1.2.0
- @nifrajs/i18n@1.2.0
- @nifrajs/image@1.2.0

## 1.1.0

### Patch Changes

- Updated dependencies [37d2383]
  - @nifrajs/web@1.1.0
  - @nifrajs/i18n@1.1.0
  - @nifrajs/image@1.1.0

## 1.0.0

### Patch Changes

- Updated dependencies [f1f0e18]
  - @nifrajs/web@1.0.0
  - @nifrajs/i18n@1.0.0
  - @nifrajs/image@1.0.0

## 1.0.0-beta.4

### Patch Changes

- @nifrajs/i18n@1.0.0-beta.4
- @nifrajs/image@1.0.0-beta.4
- @nifrajs/web@1.0.0-beta.4

## 1.0.0-beta.3

### Patch Changes

- @nifrajs/i18n@1.0.0-beta.3
- @nifrajs/image@1.0.0-beta.3
- @nifrajs/web@1.0.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- Updated dependencies [5018546]
  - @nifrajs/web@0.1.0-beta.2
  - @nifrajs/i18n@0.1.0-beta.2
  - @nifrajs/image@0.1.0-beta.2
