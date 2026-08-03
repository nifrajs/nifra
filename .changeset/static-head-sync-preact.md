---
"@nifrajs/web": patch
"@nifrajs/web-preact": patch
---

Non-hydrated pages (`hydrate: false`) omit the adapter's hydration bootstrap from `<head>` - with no client takeover, scripts like Solid's hydration registry were dead bytes on a static document. The Preact adapter's `renderToString` also returns synchronously once its renderer module is loaded (first call still resolves it lazily), so buffered renders take the synchronous fast path on every subsequent request.
