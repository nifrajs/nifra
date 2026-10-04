---
"@nifrajs/core": patch
---

`aroundCapability`: a `next()` called after its interceptor returned or timed out no longer runs the interceptors after it. It returns a promise rejected with `CapabilityInterceptorProtocolError`, the error a second `next()` call already raises.
