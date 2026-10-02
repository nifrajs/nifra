---
"@nifrajs/otel": minor
---

`otelBridge()` from `@nifrajs/otel/sdk-bridge` connects nifra spans to the OpenTelemetry SDK. The app passes its own `@opentelemetry/api`; `@nifrajs/otel` adds no dependency.

- `bridge.plugin`: `app.use(bridge.plugin)` runs each subsequent route with its request span active in the OTel context, so the SDK's own instrumentations (pg, mysql2, ioredis, undici, prisma) nest under the request span. It costs one `around()` frame per request, only when installed.
- `bridge.adapter`: mirrors nifra spans into SDK spans (name, kind, parent, links, attributes, status, timing). Pass it in `tracing({ adapters })` and the other tracers' `adapters`.
- `bridge.idGenerator`: wired as the SDK provider's `idGenerator`, mirrored spans keep nifra's exact trace and span ids, so forwarded `traceparent` headers and the trace context stored with a job name real spans. Without it the adapter warns once.
- `bridge.scope`: runs code with a nifra span active in the OTel context; pass it as `jobTracing({ scope })` or `traceEventConsumer(..., { scope })` so spans inside a job or event handler nest under it.
- Context propagation needs the SDK's AsyncLocalStorage context manager. Verified on Node 26, Bun 1.4, Deno 2.9 and workerd with `nodejs_compat`. The SDK's undici instrumentation records `fetch` only on Node, where `fetch` is undici.
