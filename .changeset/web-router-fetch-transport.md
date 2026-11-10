---
"@nifrajs/web": minor
"@nifrajs/cli": minor
---

Let a page that ships inside a native shell reach its server on another origin. `createClientRouter` takes a `fetch` option that carries the route-data GETs, prefetches and action POSTs. A build takes a `transport` module whose default export the generated entry passes to the router: `buildClient({ transport })`, the Bun and Vite dev servers, and `transport` in `nifra.config.ts`.

`serverFetch({ origin, headers, credentials })` from `@nifrajs/web/shell` builds that function. A path-absolute URL goes to `origin`, with headers (or an async header function, such as a refreshing bearer token) added to each request. Prerendered data files still load from the bundle, except for a navigation with a query string and, with live, the loads the live endpoint makes.

The same transport reaches the rest of the app. `appFetch` from `@nifrajs/web/shell` is the `fetch` for a `useQuery` fetcher or the typed client (`client(url, { fetch: appFetch })`): the transport in a shell build, the global `fetch` anywhere else. The stubs that stand in for `*.fn.ts` modules call through it, and `serverFunctions(namespace, module, { origins })` lists the shell origins the server accepts besides its own. The live client and socket take the transport and its origin, and keep-alive layers over it.

A path the shell has no page for, such as a reload at `/todos`, hydrates the document the shell ships and then navigates to that URL.
