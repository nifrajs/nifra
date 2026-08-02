---
"@nifrajs/web": minor
---

Per-route document-assembly caching for SSR. `renderPageResult` accepts an `assemblyCache` slot (new `RenderAssemblyCache` type): the request-invariant document pieces - the head (title, meta tags, style links, module preloads, hydration head) and the tail statics - are built once per route and reused, while per-request values (loader data, params, deferred state, action and layout globals) are always assembled fresh. `createWebApp` wires a slot automatically for every route whose meta chain is static (a `meta(data)` function keeps that route on fresh assembly), invalidating on module identity change so dev HMR stays correct, and a per-request CSP nonce bypasses the cache entirely. Output is byte-identical; on a realistic page (meta set + stylesheets + route chunks + an island) the render+assembly step is ~21% faster, which measures as roughly 10-15% more requests per second on the Node SSR path.
