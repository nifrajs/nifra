---
"@nifrajs/web": minor
"@nifrajs/cli": patch
---

feat(web): pages can carry a strict Content-Security-Policy and still be cached.
A per-request nonce makes every document unique, so nifra marks a nonce-bearing page
`private, no-store` and no shared cache (`withISR`, a CDN) may store it. `createCspPolicy({ header })`
is the cacheable alternative: pass it to `createWebApp({ csp })` (or `renderPage({ csp })`) instead of
`nonce`. A document then carries a nonce only when it has a script specific to this request (a
deferred value, or `meta` naming the nonce in `unsafeInlineScript`). Every other document is
nonce-free, its constant inline scripts are allowed by sha256 hash, and its CSP header is the same on
every request. `header` receives `sources`, the `script-src` list the document needs.
`nifraScriptHashes(adapter)` returns the hashes for a policy set at a proxy or CDN. Passing both `csp`
and `nonce` throws.

The page-state handover is now one inert `<script type="application/json" id="__nifra-handover">`
instead of an executable script that assigned `window.__NIFRA_DATA__` and its siblings, so page data
needs no nonce or hash under any policy. The client entry assigns the same globals before anything
reads them. Code that read those globals from an inline script running before the client entry must
run after it, or read the handover element (`HANDOVER_ID`). `nifra assure --hydration` reads the new
format. `RenderAssemblyCache` loses its `tailMid` and `tailData` slots.

`withISR` warns once when it wraps an app created with `nonce`, since it can never store one of its
pages. It also remembers, for its revalidate window, keys whose page answered `private` or
`no-store` and skips the store lookup for them. A remembered key that turns cacheable is stored again.
