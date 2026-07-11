# @nifrajs/otel

Distributed tracing for nifra. The `tracing()` plugin continues (or starts) a **W3C trace** per
request, opens an **OpenTelemetry-semantic-convention** span, and exposes `c.trace` so you can
forward the trace to downstream services. One fail-open lifecycle owns parentage, identity, timing,
errors, final status, and exactly-once completion. Pluggable adapters project that observation into
the OpenTelemetry SDK, DevTools, private backends, or structured logs. No SDK bundled; edge-safe.

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
- **Exposes `c.observation`** — integrations can start correctly-parented child observations or
  attach an adapter without rebuilding request lifecycle state.
- `responseHeader: true` also sets `traceparent` on the response (browser/client correlation).

## Adapters

Implement `ObservationAdapter` to send spans wherever you collect them. `SpanExporter` remains as a
backwards-compatible type alias:

```ts
interface ObservationAdapter {
  onStart?(span: NifraSpan): void
  onEnd(span: NifraSpan): void
}
```

- `consoleSpanExporter()` — logs each completed span as one structured line (dev / starting point).
- `tracing({ adapters: [devtoolsAdapter, privateAdapter] })` — fan out the same lifecycle; adapter
  failures are isolated and never alter the response.
- **OpenTelemetry SDK bridge** — a ~10-line adapter maps `NifraSpan` onto a real OTel `Span` from a
  `Tracer` (the attribute names already follow OTel conventions, so they pass straight through). Your
  app depends on `@opentelemetry/*`; `@nifrajs/otel` does not.

## Connect your collector

Use `traceparent` and the built-in semantic attributes in every request span, then send spans to
your own collector through an exporter. Keep the package edge-safe by installing the OpenTelemetry
SDK only in apps that need that exporter.

For non-HTTP work, `createObservationLifecycle()` exposes the same state machine directly. Prefer
it over hand-rolling traceparent parsing, clocks, error status, or completion guards.

## For AI agents

Start with [`LLM.md`](./LLM.md) — this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
