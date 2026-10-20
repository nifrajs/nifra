---
"@nifrajs/web": patch
---

A revalidation answered with a terminal status now renders that status route, as a navigation does. `router.invalidate()` and a submit's revalidation of the active route used to publish `data: null` under the page's own route when the server answered a status (a 401 after the session expired, a 404 after the action deleted the record), so the page stayed mounted with no data. They now load the status route and publish it in the page's place, with no params, layout data or action result. A status page that renders inside layouts needs those layouts' loaders, so there `invalidate()` rejects and a submit rejects with the page as its `redirectTo`, the same document fallback a navigation takes. A later reload of a status page loads its URL's own route again and renders that route, so its data never lands in the status page.
