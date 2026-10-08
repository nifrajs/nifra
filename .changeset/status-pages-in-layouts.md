---
"@nifrajs/web": minor
"@nifrajs/cli": minor
---

A root status page (`_404.tsx`, `_<status>.tsx`) or an `_error.tsx` that exports `inLayouts = true` renders inside the layouts above it with their loader data. For an unmatched URL the root middleware and layout loaders run first; otherwise the page reuses the layout data the request already loaded. When those layouts cannot render it (a loader throws, a gate or the middleware refuses) the page renders alone with the same status and is not hydrated. A page rendered with layout data is `private, no-store`, and a client navigation that lands on one loads the URL as a document. Without the export nothing changes, except that a root status page's `meta` now reaches the server-rendered head.

`createClientRouter` takes `layoutStatusRoutes`: status route ids whose page renders inside layouts, which a soft navigation loads as a document.

`nifra check` reports a root status page or `_error` beside a root `_layout` that does not export `inLayouts` (NF-C034, info).
