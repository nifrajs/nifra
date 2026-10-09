---
"@nifrajs/core": minor
"@nifrajs/middleware": patch
---

The server records each request an authentication stage accepts, and `isAuthenticatedRequest(req)` from `@nifrajs/core/server` answers for the request response hooks receive, on every runtime and after an `onRequest` hook replaces the request. `markAuthenticatedRequest(req)` records a request an integration verified outside a stage; the optional `bearer`, `apiKey`, `jwt` and `basicAuth` guards call it. `cache()` treats a response to such a request as private, so it is stored only when the response is explicitly `public` or carries `s-maxage`, whatever header carried the credential, including an `apiKey({ header })` outside `authenticatedHeaders`.
