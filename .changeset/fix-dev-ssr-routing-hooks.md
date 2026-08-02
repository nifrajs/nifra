---
"@nifrajs/web": patch
"@nifrajs/web-react": patch
"@nifrajs/web-vue": patch
"@nifrajs/web-solid": patch
"@nifrajs/web-preact": patch
---

Routing hooks now SSR-render correctly on the dev server. In dev, the adapter is imported by Bun while route modules load through Vite's SSR runner, so the router module could be evaluated twice in one process - two context objects, and `useSearch`/`useParams`/`useLocation` read a context the render never provided. The result was hooks SSR-rendering their empty defaults (`useSearch()` gave `{}`) while the same request's loader saw the validated values; hydration then papered over it on the client, so it surfaced as "the search schema doesn't work in dev". The router context in every adapter is now a `globalThis` singleton (keyed by `Symbol.for`), so both evaluations share the one context React/Vue/Solid/Preact matches providers to readers by. The Vite dev server also mirrors its client `resolve.conditions` into `ssr.resolve.{conditions,externalConditions}`, so dev SSR resolves the same `bun`-conditioned source files Bun does instead of a package's `dist` artifact - which nothing in the dev loop rebuilds, and whose staleness previously 500'd inside framework code.
