---
"@nifrajs/web": minor
"@nifrajs/web-solid": patch
---

feat(web): `_loading.tsx` is what the page slot shows while a client navigation loads. A navigation
still waiting on its data after about 120 ms swaps the page for the target route's nearest
`_loading` - the innermost one above it whose layouts are already on screen, which are the layouts
the two pages share; they stay mounted with their data. A `_loading` never renders outside a layout
above it. A navigation that settles sooner goes straight to the new page, as does one with no
eligible `_loading`; a change of search on the same path and a form submit keep the page. The
component receives `pending` and no `data`. It is browser-only: the server never renders one, and an
app without a `_loading` file ships no code for it. Where the browser runs view transitions, a
navigation's transition ends on the loading page instead of holding the old page until the data
arrives. `Manifest.loadings` lists the pages (`LoadingEntry`, each with the layouts it sits under)
and `RouteEntry.loadingIds` the ones above each route. In a `buildClient` build every page links the
loading pages' stylesheets.

A file named `_loading` was an ignored underscore file before; one kept in a routes directory for
another purpose is now a loading page.

fix(web-solid): the mounted router renders the chain the router names while a navigation is pending,
which is how a `_loading` page reaches the screen. A pending navigation on the same chain is still
skipped until it settles.
