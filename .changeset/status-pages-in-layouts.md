---
"@nifrajs/web": major
"@nifrajs/cli": major
"create-nifra": patch
---

Root status pages (`_404.tsx`, `_<status>.tsx`) and `_error.tsx` render inside the layouts above them with their loader data, and the server puts a status page's `meta` in the head. For an unmatched URL the root middleware and layout loaders run first; otherwise the page reuses the layout data the request already loaded. When those layouts cannot render it (a loader throws, a gate or the middleware refuses) a root status page renders alone and is not hydrated, and an `_error` renders inside its layouts without their data, with the same status. A page rendered with layout data is `private, no-store`, and a client navigation that lands on one loads the URL as a document. `export const inLayouts = false` renders a page the 4.x way and runs no layout loader for it.

`createClientRouter` takes `layoutStatusRoutes`: status route ids whose page renders inside layouts, which a soft navigation loads as a document.

`nifra check` reports a root status page that imports the root layout to wrap itself, since it now renders that layout twice (NF-C034, warning). The site templates' `_404` pages no longer wrap the layout.
