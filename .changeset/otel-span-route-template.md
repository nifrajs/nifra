---
"@nifrajs/otel": patch
---

`tracing()` names a request span `{method} {route template}` - `GET /users/:id`, not `GET /users/42` - and records the template as `http.route`, as OpenTelemetry's HTTP conventions describe. The raw path stays in `url.path`. A method outside HTTP's own set is recorded as `_OTHER`, with the original in `http.request.method_original`.
