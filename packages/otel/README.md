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

- **Continues an inbound trace** - parses the `traceparent` header; reuses its `trace-id` and records
  the inbound span as the parent. No inbound header → starts a fresh trace.
- **Opens a span** with HTTP semantic-convention attributes (`http.request.method`, `url.path`,
  `http.response.status_code`, optional `service.name`), ended on response with duration + status
  (`error` for 5xx, `ok` otherwise).
- **Exposes `c.trace`** (`{ traceId, spanId, parentSpanId?, sampled, traceparent }`) - spread
  `traceHeaders(c.trace)` into any downstream `fetch`/`ctx.api` call to continue the trace.
- **Exposes `c.causality`** - a bounded, payload-free request node that survives durable command,
  event, workflow, projection, and repair seams. `traceHeaders(c.trace, c.causality)` forwards both
  conventions to a trusted downstream service.
- **Exposes `c.observation`** - integrations can start correctly-parented child observations or
  attach an adapter without rebuilding request lifecycle state.
- `responseHeader: true` also sets `traceparent` on the response (browser/client correlation).

## Durable causality and trust

Pass a durable recorder to append the request root before the handler runs. An explicitly configured
recorder is correctness evidence, so its failure fails the request closed:

```ts
app.use(tracing({
  exporter,
  causality: {
    recorder: durableGraphStore,
    acceptInbound: (request) => verifyInternalServiceCredential(request),
  },
}))
```

Inbound causality headers are **not trusted by default**. This prevents an internet client from
injecting fake parents into another execution timeline. Supply `acceptInbound` only at an authenticated
service-to-service boundary; a false, thrown, or rejected decision starts a fresh graph. W3C
`traceparent` remains normal observability context, but a fresh durable execution id includes the
server-generated span id and is not copied from the untrusted header.

Use `causalitySpanLink(context)` when durable work opens a later observation. It creates a real OTel
link to the nearest observed causal ancestor and drops invalid/unanchored contexts rather than
inventing trace identity.

## Adapters

Implement `ObservationAdapter` to send spans wherever you collect them:

```ts
interface ObservationAdapter {
  onStart?(span: NifraSpan): void
  onEnd(span: NifraSpan): void
}
```

- `consoleSpanExporter()` - logs each completed span as one structured line (dev / starting point).
- `tracing({ adapters: [devtoolsAdapter, privateAdapter] })` - fan out the same lifecycle; adapter
  failures are isolated and never alter the response.
- **OpenTelemetry SDK bridge** - `otelBridge()` from `@nifrajs/otel/sdk-bridge` (below). Your app
  depends on `@opentelemetry/*`; `@nifrajs/otel` does not.

Every span carries an OTel `kind`: request spans are `server`, capability and cache spans
`internal`, job enqueues `producer`, job runs and event consumers `consumer`. `otlpExporter()` sends
it as the OTLP enum; a span without one goes out as `SERVER`.

## Cache, jobs and events

Work that runs through a context bound to the request joins the request's trace. Each tracer takes
the same `exporter` / `adapters` options as `tracing()`; pass the same adapters to all of them.

```ts
import { cacheTracing } from "@nifrajs/otel/cache"
import { jobTracing } from "@nifrajs/otel/jobs"

const cache = createCache({ observer: cacheTracing({ exporter }) })
const queue = createQueue({ store, instrument: jobTracing({ exporter }) })
const email = queue.define("email-job", {
  async handler(payload, ctx) {
    await cache.for(ctx).wrap("tmpl:welcome", loadTemplate) // ctx.trace: the process span
  },
})

app.use(tracing({ exporter })).get("/orders", async (c) => {
  const orders = await cache.for(c).wrap("orders:recent", loadOrders) // "cache wrap", outcome miss/hit
  await email.for(c).enqueue({ to: c.query.to }) // "send email-job", producer
  return orders
})
```

- **Cache** (`@nifrajs/otel/cache`): one `cache <op>` span per operation on a `cache.for(c)` view,
  with `nifra.cache.operation`, `nifra.cache.outcome` (`hit`, `stale`, `miss`, `ok`, `error`) and
  `nifra.cache.tag_count`. Raw keys stay in the process: the span carries the key prefix (`user:42`
  gives `user`) unless `keyAttribute` is `"none"` or a function. A stale read's background refresh is a
  separate `cache revalidate` trace, linked to the request span. The unbound cache is not traced.
- **Jobs** (`@nifrajs/otel/jobs`): `send <job>` (producer) per enqueue and `process <job>` (consumer)
  per attempt, with the OTel messaging attributes (`messaging.system = "nifra.jobs"`,
  `messaging.operation.type` / `.name`, `messaging.destination.name`, `messaging.message.id`). The
  send span's context is stored with the job; each attempt is its child, plus a link to it, so one
  trace runs from the request to the worker. A failed attempt is an error span, and the one that
  dead-letters the job carries `nifra.job.dead_lettered = true`. A malformed stored traceparent starts
  a new trace.
- **Events** (`@nifrajs/otel/events`): nifra does not deliver events, so wrap the consumer once.
  `traceEventConsumer(contractOrRegistry, handler, { exporter })` gives each envelope a
  `process <type>` span linked to the producer through its causality. Input that fails to parse is an
  error span with an issue count and never reaches the handler. To give an envelope that link, build
  its causality from the request: `contract.create(payload, { id, causality:
  continueCausality(c.causality, "event", id, { relation: "emitted" }).context })`.

Error text and payloads never enter a span.

## OpenTelemetry SDK bridge

The SDK's own instrumentations (pg, mysql2, ioredis, undici, prisma) read the active span from the
OTel context. `otelBridge()` puts nifra's spans there; the app passes its own `@opentelemetry/api`.

```ts
import * as api from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { otelBridge } from "@nifrajs/otel/sdk-bridge"

const bridge = otelBridge({ api })
const provider = new BasicTracerProvider({
  idGenerator: bridge.idGenerator, // mirrored spans keep nifra's ids
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
})
api.trace.setGlobalTracerProvider(provider)
api.context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())

app.use(tracing({ adapters: [bridge.adapter] })).use(bridge.plugin)
const queue = createQueue({ store, instrument: jobTracing({ adapters: [bridge.adapter], scope: bridge.scope }) })
```

- `bridge.plugin` runs each subsequent route with its request span active, so a pg query or `fetch`
  inside the handler is a child of the request span. It costs one `around()` frame per request, only
  when installed.
- `bridge.adapter` mirrors nifra spans into SDK spans (kind, parent, links, attributes, status,
  timing), so one SDK pipeline exports everything. Leave it out and keep `otlpExporter()` if nifra's
  own exporter ships nifra's spans; the SDK spans still nest under them.
- `bridge.idGenerator` makes mirrored spans keep nifra's exact trace and span ids, so the
  `traceparent` nifra forwards and the trace context a job stores name real spans. Without it the
  adapter warns once.
- `bridge.scope` runs code with any nifra span active: pass it to `jobTracing()` and
  `traceEventConsumer()` so queries inside a job or event handler nest under it.

Context propagation needs the SDK's AsyncLocalStorage context manager. Checked on Node 26, Bun 1.4,
Deno 2.9 and workerd (`nodejs_compat`): a span started in a handler, after an `await`, is a child of
the request span on all four. The SDK's undici instrumentation records `fetch` only on Node, where
`fetch` is undici; Bun's and Deno's `fetch` produce no undici span.

## Connect your collector

Use `traceparent` and the built-in semantic attributes in every request span, then send spans to
your own collector through an exporter. Keep the package edge-safe by installing the OpenTelemetry
SDK only in apps that need that exporter.

For non-HTTP work, `createObservationLifecycle()` exposes the same state machine directly. Prefer
it over hand-rolling traceparent parsing, clocks, error status, or completion guards.

## For AI agents

Start with [`LLM.md`](./LLM.md) - this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
