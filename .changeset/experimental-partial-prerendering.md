---
"@nifrajs/web": minor
"@nifrajs/web-react": minor
---

Experimental and unstable: partial prerendering. With `createWebApp({ experimental: { ppr: { shellChecks } } })`, a route whose backend half exports `shellLoader` streams a shell shared by every visitor, then each `dynamic` boundary as it settles. The shell loader receives no request, and a shell is shared only for a route that passed the import check for this deployment; any other route renders whole. Hole HTML is checked on the server and inserted without running scripts, every script in the document is allowed by hash, and leaving the page cancels the holes still loading. The React adapter renders a hole's HTML with `renderFragment`.
