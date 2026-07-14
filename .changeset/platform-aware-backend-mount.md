---
"@nifrajs/core": minor
"@nifrajs/client": minor
"@nifrajs/web": minor
---

Add an explicit symbol-keyed in-process backend mount interface. `inProcessClient` implements the
interface and `createWebApp` forwards the outer request's platform context through it, so an
auto-mounted backend receives the same Workers `env` bindings and `waitUntil` lifetime as the web app.

The released `.fetch(url, init)` duck-typed mount remains as a compatibility fallback for custom
bridges. `Server.onRequest` now receives the optional platform object as its second argument.
