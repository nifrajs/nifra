---
name: nifra-web
description: Use when building the full-stack side of a Nifra app - file routes, layouts, loaders and actions, forms, server functions, streaming SSR, islands, SSG and ISR, the query cache, and the React, Vue, Solid, Svelte, or Preact render adapters. Covers the client/server boundary rules and the hydration errors that boundary produces. Load after the `nifra` skill.
metadata:
  docs: https://nifra.dev/docs/routing
---

# Nifra: full-stack rendering

`@nifrajs/web` is the framework-agnostic SSR core; `@nifrajs/web-react`, `-vue`, `-solid`,
`-svelte`, and `-preact` are render adapters over the same routing, loaders, streaming, and islands.
Switching UI library is an adapter import, not a rewrite.

Call `nifra_context` first in an existing app: it returns the actual route tree and conventions, which
beats inferring them from a directory listing.

## Data flows one way

```
route file -> loader (server) -> component (server render, then hydrate) -> action (server) -> revalidate
```

- **Loader** - runs on the server for the matched route. Returns typed data to the component. Reach
  your own API through `ctx.api` (an in-process client - no HTTP hop, no base URL, no auth replay).
- **Action** - handles a mutation, then revalidation refreshes the loaders that matter.
- **Component** - renders on the server, then hydrates. It must be safe to run in both places.

Do not `fetch()` your own backend from a loader. `ctx.api` is the in-process path and it is typed.

## The boundary is enforced, not advisory

A server-only module that reaches the browser bundle is a **build error**. That is deliberate:
leaking a DB client or a secret into client JS is the failure mode this prevents.

Signals and their causes:

| Error | Cause |
|---|---|
| `... reached the client bundle` | A `node:` or native import pulled in from a component or route module |
| `server-only module reached the client bundle` | A module carrying the server-only marker was imported from client code |
| `resolveDispatcher` / `Invalid hook call` | Two copies of the UI framework. The adapter dedupes it at build time - a stale `dist/` or a second install is the usual source |

Fixes: move the server work into a loader, an action, or a server function; keep secrets in modules
the client never imports; rebuild before blaming the code.

**Server functions** are the escape hatch that stays safe: write the function on the server, call it
from a component. The module body never ships, the arguments are validated, and the mounted function
is an ordinary route - so assurance, capabilities, and the effect ledger still apply to it.

## Forms work before hydration

There is a window between HTML arriving and JS booting. Nifra keeps it usable: progressive-enhancement
forms and links function during it, and a JS-only form whose native submit would break is guarded
automatically. Do not disable a submit button until hydration; do not build a form that only works
after JS. If you add `onSubmit` with `preventDefault`, make sure the action still handles a native
POST.

## Rendering modes

- **SSR** - per-request render. The default.
- **Streaming** - Suspense plus `defer()`, on every runtime including the edge. Stream the slow part;
  do not block the shell on it.
- **SSG / ISR** - prerender static routes, enumerate dynamic ones, cache with stale-while-revalidate.
- **Islands** - ship interactivity for one component instead of the page.

## Query cache

`useQuery` / `createQuery` (naming follows the adapter's idiom): keyed cache, dedup, staleness,
invalidation. Use it rather than a `useEffect` fetch. An action's revalidation and the query cache
are the same invalidation story - do not run a second, hand-rolled one alongside them.

## Dev loop

```sh
nifra dev      # Vite-backed HMR, state preserving
nifra build
nifra start
```

`@nifrajs/web/dev` is the Bun-native HMR loop with no Vite dependency. Production builds use Bun.

If dev behaviour disagrees with a fresh build, suspect a stale `dist/` before suspecting the code -
run `nifra doctor`.

## Common mistakes

| Mistake | Do instead |
|---|---|
| `fetch("/api/...")` in a loader | `ctx.api` |
| Data fetching in `useEffect` | Loader, or the query cache |
| Importing a DB client into a route component | Loader, action, or server function |
| Blocking the whole page on one slow query | `defer()` plus Suspense |
| Adding a second copy of React/Vue to fix a resolution error | Rebuild; the adapter dedupes at build time |
