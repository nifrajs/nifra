---
"@nifrajs/otel": minor
---

Spans carry an OpenTelemetry span kind.

- `NifraSpan.kind` and `StartObservation.kind` take `"server" | "client" | "producer" | "consumer" | "internal"`.
- `otlpExporter()` sends each kind as its OTLP enum value. A span without a kind is sent as `SERVER`.
- `tracing()` request spans are `server` spans; `effectTracing()` capability spans are `internal` spans.
- `consoleSpanExporter()` logs the kind when a span has one.
