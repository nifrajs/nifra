---
"@nifrajs/web": patch
---

fix(web): a redirect during a client navigation or form post lands on its target without a reload.

A loader, gate or middleware that answered a client navigation with `redirect()` had the redirect
followed by `fetch`, so the router rendered the target's data under the route it was navigating to, at
that route's URL. A data request now answers a redirect with a `204` carrying `x-nifra-redirect` and the
redirect's own headers, `Set-Cookie` included, and a same-origin target travels as a path. The client
router loads that target in place: the address bar shows it, replacing the entry a navigation added or
adding one after a form post, and `pendingPath` moves to it while it loads. A redirect to another origin
or to a `#fragment` loads as a document and replaces the entry it answered; a target whose scheme is not
`http:` or `https:` is never loaded, and the page navigated to loads as a document. A form whose action has run
is never posted a second time: when loading the page that shows the result fails, that page loads as a
document instead.
