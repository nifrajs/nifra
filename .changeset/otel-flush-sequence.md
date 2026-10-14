---
"@nifrajs/otel": patch
---

`otlpExporter`'s `flush()` and `shutdown()` no longer resolve while a span queued before the call is still exporting. Settlement counted spans sent, failed or dropped, so a later span dropped on queue overflow counted toward an earlier flush and resolved it before its batch had settled; a flush now waits until every span queued before it has left the queue and the export in flight.
