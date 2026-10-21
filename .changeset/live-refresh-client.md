---
"@nifrajs/web": minor
---

`@nifrajs/web/live-client` keeps a live page fresh in the browser. `liveClient()` gives the router a `fetchData` that sends every route load through the live load endpoint, and `attach(router)` opens one socket per tab that watches the grants of what is on screen - the page and the target an intercept boundary holds. A change reloads only the owners that read the changed key, keeping the rest as shown; changes during a load lead to at most one more load, a navigation presents the page it leaves so unchanged layouts carry over, grants renew a minute before they expire, and a frame with no grant, or every frame while the socket is down, polls every 30 s. A different viewer gets a new socket and cleared caches. `generateClientEntry({ live })` wires it into the client entry; without `live` the entry is unchanged. `router.invalidate()` now also drops warmed prefetches of what it invalidates, and the live socket's `ready.stale` lists stale owners per grant.
