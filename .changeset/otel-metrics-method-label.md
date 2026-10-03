---
"@nifrajs/otel": patch
---

`metrics()` labels a request method outside HTTP's standard set as `_OTHER`, following OpenTelemetry's HTTP conventions. A runtime that accepts extension methods, such as Deno, can no longer be made to create a new series per request.
