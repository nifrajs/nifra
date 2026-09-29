---
"@nifrajs/web": patch
---

fix(web): a page the server rendered as a status page (`_404`, `_410`, ...) hydrates as that page,
even when the URL also matches a route pattern, so a loader's `notFound()` stays a 404 in the browser.
Routable `_`-prefixed directories such as `routes/_admin/` still hydrate as themselves.

fix(web): build-vs-dev manifest parity passes for apps with `_`-prefixed routes. Both sides order
route ids with the exported `compareRouteIds`, and a module-graph mismatch names what differs: the
routes on one side only, each route's chunk counts, or the route order.
