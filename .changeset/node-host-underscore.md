---
"@nifrajs/node": patch
---

`serve()` accepts a `Host` name with an underscore, such as a container service name (`api_gateway:3000`). It used to answer every such request 400. The same names are accepted in `allowedHosts` and `canonicalHost`.
