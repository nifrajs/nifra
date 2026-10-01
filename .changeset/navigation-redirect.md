---
"@nifrajs/web": patch
---

fix(web): a redirect during a client navigation lands on its target.

A loader or a layout gate that answered a client navigation with `redirect()` had the redirect followed
by `fetch`, so the router rendered the target's data under the route it was navigating to, at that
route's URL. The navigation's data request now answers a redirect with a `204` carrying
`x-nifra-redirect`, as an action's does, and the browser loads the target as a page. A form whose action
ran and whose page then redirects loads the target instead of posting the form again.
