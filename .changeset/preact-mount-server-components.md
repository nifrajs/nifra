---
"@nifrajs/web-preact": patch
---

A page that `mountRouter` (or the keep-alive mount) hydrates receives `props.serverComponents`, the same state the server rendered it with. It was `undefined` on the client, so a `ServerComponent` outlet given that state had nothing to resolve.
