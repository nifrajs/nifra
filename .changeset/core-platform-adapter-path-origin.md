---
"@nifrajs/core": patch
---

`toNetlifyHandler()` and `toLambdaHandler()` keep the Host header's origin when the event carries no `rawUrl` (Netlify) or `requestContext.domainName` (API Gateway). A path that starts with `//`, such as `//evil.example/admin`, used to become the request URL's host (`https://evil.example/admin`), so an origin comparison against `request.url` saw the wrong host. It is now the path `//evil.example/admin` on the Host.
