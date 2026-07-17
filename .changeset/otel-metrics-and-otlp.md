---
"@nifrajs/otel": minor
---

Production observability: a batching OTLP span exporter and RED metrics.

- `otlpExporter({ url, headers?, batch?, onError? })` ships spans to any OpenTelemetry collector over OTLP/HTTP (JSON) with in-process batching - dependency-free and edge-safe, matching the package's no-SDK stance. `tracing({ exporter: otlpExporter({ url: "http://localhost:4318/v1/traces" }) })` is now production-usable without writing your own exporter. `flush()`/`shutdown()` drain on graceful stop.
- `.use(metrics())` from `@nifrajs/otel/metrics` records RED metrics - `nifra_http_requests_total`, `nifra_http_request_duration_seconds`, `nifra_http_requests_in_flight` - labeled by method, the matched route TEMPLATE (so `/users/:id` is one series, not one per id), and status, and exposes them in Prometheus text at `/metrics`. `createMetricsRegistry()` lets an app register custom counters/gauges/histograms that render at the same endpoint. Zero dependencies; the subpath keeps it out of tracing-only bundles.
