---
"@nifrajs/web": minor
"@nifrajs/web-react": patch
"@nifrajs/web-vue": patch
"@nifrajs/devtools": minor
---

A kept page that a partially prerendered document filled stops its holes while it is hidden: a hole still loading is cancelled on the server, and a hole reload on its way is dropped. When the page comes back, its restore names the hole hosts in the data request, so each hole refills in place with `aria-busy="true"` until the fill lands, also on a route with `keepAlive: { revalidate: false }`. A `keepAlive` route's shared shell renders the page inside the same slot wrappers as the app's other documents, so it hydrates; an interactive hole on a kept React page keeps its own root, and its state, while `<Activity>` hides the page, and its root goes when the page is dropped.

In an app with both `keepAlive` routes and live refresh, a live reload keeps the owners whose keys did not change, as it does without `keepAlive`. A kept page is not watched while it is hidden; when it comes back, what changed meanwhile reloads, and while the page runs its own reload, live refresh waits for that load's grant instead of loading the page a second time.

In development, a keep-alive app lists its kept pages on `window.__nifraKeepAlive` (`KEPT_PAGES_GLOBAL`, `KeptPageInfo` from `@nifrajs/web/keep-alive`): instance, path, route, hidden time and element count. Adapters report each slot's elements with `noteKeptView`. The `@nifrajs/devtools` overlay shows the list under its request log. Production builds drop it.
