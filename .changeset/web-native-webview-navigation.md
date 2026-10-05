---
"@nifrajs/web": patch
---

Client navigation works on a page served from a native webview's own scheme, such as Capacitor's
`capacitor://localhost` on iOS: link clicks, prefetch, `navigate()` and `<form method="post">` stay
in-app there instead of the click being swallowed. Whether a URL belongs to the app is decided by the
document's scheme and host rather than `URL.origin`, which reads `"null"` for every non-special scheme,
so a `javascript:` target is still never taken in. An opaque or `file:` page, where history cannot move
to another path, leaves its links to the browser.
