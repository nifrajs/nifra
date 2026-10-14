---
"@nifrajs/web": patch
"@nifrajs/web-react": patch
---

A React page that suspends without `defer()` (`use(promise)` or `lazy` inside `<Suspense>`) now renders its resolved content on the server. The buffered fast path rendered it with React's string renderer, which cannot wait, so the document kept the fallback for good (with `hydrate: false` or JavaScript off, the content never appeared), and a component suspending with no boundary above it failed the render. `RenderAdapter.renderToString` may now return `undefined` for a render that suspended; the React adapter does so, and the page is streamed instead, with a CSP nonce when the policy needs one.
