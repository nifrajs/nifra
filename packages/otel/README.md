# @nifrajs/otel

Distributed tracing for nifra. The `tracing()` plugin continues (or starts) a **W3C trace** per
request, opens an **OpenTelemetry-semantic-convention** span, and exposes `c.trace` so you can
forward the trace to downstream services. Spans go to a **pluggable exporter** — bridge to the
OpenTelemetry SDK, or log them directly. No SDK bundled; edge-safe.

```ts
import { tracing, traceHeaders, consoleSpanExporter } from "@nifrajs/otel"

const app = server()
  .use(tracing({ exporter: consoleSpanExporter(), serviceName: "orders-api" }))
  .get("/orders/:id", async (c) => {
    // continue the trace into a downstream call:
    const res = await fetch(`${INVENTORY_URL}/stock`, { headers: traceHeaders(c.trace) })
    return { id: c.params.id, inStock: (await res.json()).ok }
  })
```

## What it does per request

- **Continues an inbound trace** — parses the `traceparent` header; reuses its `trace-id` and records
  the inbound span as the parent. No inbound header → starts a fresh trace.
- **Opens a span** with HTTP semantic-convention attributes (`http.request.method`, `url.path`,
  `http.response.status_code`, optional `service.name`), ended on response with duration + status
  (`error` for 5xx, `ok` otherwise).
- **Exposes `c.trace`** (`{ traceId, spanId, parentSpanId?, sampled, traceparent }`) — spread
  `traceHeaders(c.trace)` into any downstream `fetch`/`ctx.api` call to continue the trace.
- `responseHeader: true` also sets `traceparent` on the response (browser/client correlation).

## Exporters

Implement `SpanExporter` to send spans wherever you collect them:

```ts
interface SpanExporter {
  onStart?(span: NifraSpan): void
  onEnd(span: NifraSpan): void
}
```

- `consoleSpanExporter()` — logs each completed span as one structured line (dev / starting point).
- **OpenTelemetry SDK bridge** — a ~10-line adapter maps `NifraSpan` onto a real OTel `Span` from a
  `Tracer` (the attribute names already follow OTel conventions, so they pass straight through). Your
  app depends on `@opentelemetry/*`; `@nifrajs/otel` does not.

## Connect your collector

Use `traceparent` and the built-in semantic attributes in every request span, then send spans to
your own collector through an exporter. Keep the package edge-safe by installing the OpenTelemetry
SDK only in apps that need that exporter.

## For AI agents

Building on nifra with an AI coding agent? The repo's [`AGENTS.md`](../../AGENTS.md) is the copy-paste
quick reference, and [`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run
`nifra check` as the done-gate, or `nifra mcp` to give the agent live project tools.
