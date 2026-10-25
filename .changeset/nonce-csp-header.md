---
"@nifrajs/web": minor
---

`createWebApp({ nonce, cspHeader })` writes the Content-Security-Policy header itself. `cspHeader` receives `{ sources, nonce }`, where `sources` is `'nonce-…'` plus a `'sha256-…'` hash for each constant inline script nifra writes, and returns the header value or `undefined` to send none. Every document the app renders carries it, built from the nonce on that document's own scripts: pages, status pages, `_error`, and streamed and deferred documents. A wrapper that rebuilds the request with `new Request(url, req)` in front of the app no longer has to find out which nonce a document used. A document the resolver leaves nonce-free gets the hash sources alone. Nonce documents stay `private, no-store`. `cspHeader` needs `nonce`, and is refused beside `csp` or beside a `createNonceResolver({ header })` resolver.
