---
"@nifrajs/aws-lambda": patch
---

When an event carries no `requestContext.domainName`, the adapter uses the `Host` header for the request URL only if it is a plain host and port. A `Host` holding `/`, `?`, `#` or `@` can no longer change the URL's host or the path the app routes on; such a request is built on `localhost` instead.
