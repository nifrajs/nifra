---
"@nifrajs/web": patch
---

The generated Node and Vercel server for a server-components build takes the request's origin from the Host header only. A request target that starts with `//` (`GET //evil.example/admin`) used to resolve as host `evil.example`, path `/admin`; it is now path `//evil.example/admin` on the real host. An absolute-form target is routed by its path, and a Host header with characters outside a host name answers 400.
