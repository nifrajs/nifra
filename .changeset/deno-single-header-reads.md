---
"@nifrajs/core": patch
---

On Deno, the `Host` check, the WebSocket upgrade probe and the framework's own header reads (the JSON body lane's `content-type` and `content-length`, `c.header()`, cookies) read the one header they need instead of making Deno build the request's whole header list. A bare route keeps the `Host` check and dot-segment resolution and no longer pays about 4% of its throughput for them; an app with a `ws()` route no longer pays it on every plain request. The answers are unchanged, except that `c.header()` with a name no header can carry now returns `null` on Deno, as it does on Node, instead of throwing. A request Deno did not parse itself - constructed, cloned or rebuilt by a hook - is still read through its `headers`, and a malformed `Host` is still refused with `400 {"ok":false,"error":"invalid_host"}` on HTTP and on the WebSocket handshake.
