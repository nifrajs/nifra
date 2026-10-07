---
"@nifrajs/otel": minor
---

`otlpExporter` sends one export at a time; spans that end meanwhile wait in the `maxQueue`-bounded queue instead of each opening another POST. A new `timeoutMs` option (default 30000) aborts and reports an export that takes too long. `flush()` resolves once every span queued before the call was sent, failed or dropped, and `shutdown()` waits for the export in flight.
