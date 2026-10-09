---
"@nifrajs/otel": major
"@nifrajs/devtools": patch
---

`tracing()` now reports a matched request's route template as `url.path` (for example `/users/:id`), so an email, an id or a token in a path segment no longer reaches the trace backend. Pass `rawUrlPath: true` to report the raw path as before. Requests that match no route still report their raw path. DevTools installs its own tracing with `rawUrlPath: true`, so its local request log is unchanged.
