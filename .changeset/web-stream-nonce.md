---
"@nifrajs/web": minor
"@nifrajs/web-react": patch
"@nifrajs/web-solid": patch
"@nifrajs/web-preact": patch
---

fix(web): pages that `defer()` keep working under a nonce Content-Security-Policy.
React, Solid and Preact stream inline scripts to reveal a Suspense boundary that resolves after the
shell, and none of them carried the document's nonce, so a nonce CSP blocked them and the boundary
stayed on its fallback. `RenderAdapter.renderToStream` now receives `{ nonce }` as an optional third
argument (`RenderStreamOptions`), and every adapter that streams scripts applies it: React and Solid
through their own `nonce` option, Preact on the one island-runtime script it streams. A script the
app renders itself never inherits the nonce. Vue, Svelte and the vanilla adapter stream no scripts.
