---
"@nifrajs/web": major
"@nifrajs/client": major
---

The in-process backend mount is now exclusively the symbol-keyed `BackendMount` interface that `inProcessClient()` / `testClient()` implement.

`createWebApp({ api })` auto-mounts a backend only through that symbol seam - the platform-aware path that forwards `env` / `waitUntil`. The `.fetch(url, init)` mount convention is gone: an `api` that only exposes a callable `.fetch` is no longer auto-mounted. Backends passed as `inProcessClient(app)` / `testClient(app)` are unaffected, since they carry the symbol mount already.
