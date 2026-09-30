---
"@nifrajs/web": minor
---

feat(web): a `_404.tsx` in a directory answers for that part of the app. `routes/admin/_404.tsx`
renders for the unmatched URLs under `/admin` and for `notFound()` from the routes beneath it - the
nearest one wins - inside the layouts at or above it, with their loader data. The layouts run as
they do for a page, so a `gate` decides before anything renders. The page is served non-hydrated,
and with `cache-control: private, no-store` once a layout loaded data for it. `Manifest.notFounds`
lists these pages (`NotFoundEntry`, each with the `NotFoundScope` patterns it answers) and
`RouteEntry.notFoundIds` the ones above each route.

fix(web): a `_404.tsx` below the routes root no longer takes the place of the root one. Two route
groups that each hold a `_404` for the same URL prefix are refused at boot, unless a directory that
contains both holds one as well.
