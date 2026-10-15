---
"@nifrajs/web": minor
"@nifrajs/cli": minor
---

`nifra build --target bun` and `--target node` prerender the routes that opt in (`export const prerender = true`, or `getStaticPaths`) into `_prerendered/` beside `server.js`. The server then answers those pages from their file instead of rendering them on every request.

The file is served from the page route, so `use` middleware and every request hook still run first. A gate in front of a page still applies, and response hooks still add their headers. The page carries the `content-language` and Content-Security-Policy its build-time render produced. Loader headers and cookies are not sent, as for any prerendered page.

These keep rendering on demand:
- a request with a query string
- a navigation data or server-component request
- a draft-mode visitor
- a page whose build-time render set a cookie, was `private` or `no-store`, or varied on a request header
- every page of an app with a `nonce`, whose documents need a nonce minted per request.

On Node, the SSR benchmark's prerendered catalog page is served about 2.1x (Svelte) to 2.6x (Vue) faster than rendering it on each request.

New in `@nifrajs/web`:
- `createWebApp({ prerenderedPages })`
- `prerenderedPageReader`, which opens only the build's own files inside the directory and keeps each page in memory once read, up to 32 MiB by default
- `PrerenderEntry.serveHeaders` on `prerenderRoutes` results.

Prerendering now runs during these builds, so it loads every route module and runs the opted-in loaders at build time. Two effects:
- If a route module cannot load there, the build warns and every page renders on demand, as before.
- A secret in a prerendered page fails the build, as it does for `--target static`.

The Vite pipeline, `deno`, and the edge targets are unchanged.
