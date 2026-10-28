---
"@nifrajs/core": patch
---

On Bun, `listen()` keeps serving an app's routes from Bun's native route table when the app registers `onRequest` hooks that may answer or rewrite a request. The hooks run first, and the route the table matched runs unless a hook replaced the request.
