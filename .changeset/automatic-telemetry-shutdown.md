---
"@nifrajs/core": minor
"@nifrajs/otel": minor
---

Add a generic server `onStop` lifecycle hook and have OTLP tracing exporters flush and shut down automatically when attached to a server. Manual OTLP lifecycle calls remain available for standalone exporters.
