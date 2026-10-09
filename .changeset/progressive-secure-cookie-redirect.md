---
"@nifrajs/web": patch
---

A native form POST to a server-component owner route whose action sets a Secure cookie (the default) while the app sees the request as `http:`, as it does behind a TLS terminator, now answers 303 to the same path so the browser makes the owner GET with the cookie it kept. Before, the post-action render ran without the new cookie. The 303 `Location` of a progressive redirect is now relative, so the browser stays on its own scheme.
