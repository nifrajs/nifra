import { CodeBlock } from "../../shared/highlight"
import { docsMeta } from "../../shared/meta"

export const meta = docsMeta(
  "/docs/observability",
  "Nifra - Tracing & observability",
  "One trace from the request through the cache, the job queue and the worker, plus the OpenTelemetry SDK's own database and HTTP spans, without bundling the SDK.",
)

const REQUEST = `// doc-check: skip - the collector URL and handler are app-specific.
import { otlpExporter, traceHeaders, tracing } from "@nifrajs/otel"

const exporter = otlpExporter({ url: "http://localhost:4318/v1/traces", serviceName: "orders-api" })

app.use(tracing({ exporter })).get("/orders/:id", async (c) => {
  // c.trace is the request span; forward it to keep one trace across services.
  const stock = await fetch(INVENTORY_URL, { headers: traceHeaders(c.trace) })
  return { id: c.params.id, inStock: (await stock.json()).ok }
})`

const CACHE_AND_JOBS = `// doc-check: skip - @nifrajs/otel subpaths are outside the doc sandbox; store and loaders are app-specific.
import { createCache } from "@nifrajs/cache"
import { createQueue } from "@nifrajs/jobs"
import { cacheTracing } from "@nifrajs/otel/cache"
import { jobTracing } from "@nifrajs/otel/jobs"

const cache = createCache({ observer: cacheTracing({ exporter }) })
const queue = createQueue({ store, instrument: jobTracing({ exporter }) })

const email = queue.define("email-job", {
  async handler(payload: { to: string }, ctx) {
    // ctx.trace is this attempt's span: the cache span below is its child.
    const template = await cache.for(ctx).wrap("tmpl:welcome", loadTemplate)
    await send(payload.to, template)
  },
})

app.use(tracing({ exporter })).get("/orders", async (c) => {
  const orders = await cache.for(c).wrap("orders:recent", loadOrders) // span "cache wrap"
  await email.for(c).enqueue({ to: "ada@example.com" })            // span "send email-job"
  return orders
})`

const EVENTS = `// doc-check: skip - @nifrajs/otel subpaths are outside the doc sandbox; the contract is app-specific.
import { continueCausality } from "@nifrajs/core/causality"
import { traceEventConsumer } from "@nifrajs/otel/events"

// Producer: the event's causality starts from the request, so the consumer can link back to it.
app.post("/pay", (c) => {
  const id = \`evt_\${crypto.randomUUID()}\`
  const { context } = continueCausality(c.causality, "event", id, { relation: "emitted" })
  outbox.push(orderPaid.create({ orderId: "o-1" }, { id, causality: context }))
  return { ok: true }
})

// Consumer: one "process order.paid" span per envelope, linked to the request above.
const consume = traceEventConsumer(orderPaid, (event, ctx) => fulfil(event.payload), { exporter })
const result = await consume(message) // { success: false, issueCount } for input that does not parse`

const BRIDGE = `// doc-check: skip - @opentelemetry/* packages are not installed in the doc sandbox.
import * as api from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { otelBridge } from "@nifrajs/otel/sdk-bridge"

const bridge = otelBridge({ api })
api.trace.setGlobalTracerProvider(
  new BasicTracerProvider({
    idGenerator: bridge.idGenerator, // mirrored spans keep nifra's exact ids
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  }),
)
api.context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())

app.use(tracing({ adapters: [bridge.adapter] })).use(bridge.plugin)
const cache = createCache({ observer: cacheTracing({ adapters: [bridge.adapter] }) })
const queue = createQueue({
  store,
  instrument: jobTracing({ adapters: [bridge.adapter], scope: bridge.scope }),
})`

const TRACE = `GET /orders                         orders-api     server
  pg.query SELECT orders            orders-api     client    (the cache loader)
  cache wrap                        orders-api     internal  outcome=miss
  pg.query INSERT                   orders-api     client    (the job store)
  send email-job                    orders-api     producer
    process email-job               orders-worker  consumer  (child of send, plus a link)
      pg.query SELECT orders        orders-worker  client    (the job handler)
      pg.query DELETE               orders-worker  client    (the job completing)`

export default function Observability() {
  return (
    <div className="prose">
      <h1 className="page">Tracing &amp; observability</h1>
      <p className="lead">
        <code>@nifrajs/otel</code> traces each request with W3C trace context and OpenTelemetry
        semantic conventions, and ships no SDK. Cache operations, background jobs and event consumers
        join the request's trace through the context you bind them to, and a small bridge puts the
        OpenTelemetry SDK's own database and HTTP spans under the same tree.
      </p>

      <h2>Request spans</h2>
      <CodeBlock code={REQUEST} lang="ts" />
      <p>
        <code>tracing()</code> continues an inbound <code>traceparent</code> or starts a trace, and
        ends one <code>server</code> span per request with the HTTP attributes. Spans go to any{" "}
        <code>ObservationAdapter</code>: <code>otlpExporter()</code> posts OTLP/JSON to a collector
        from Bun, Node, Deno or Workers.
      </p>

      <h2>Cache and jobs</h2>
      <CodeBlock code={CACHE_AND_JOBS} lang="ts" />
      <p>
        An operation is traced when it runs through a view bound to a context:{" "}
        <code>cache.for(c)</code> and <code>job.for(c)</code>. The cache reports each operation to its
        observer after it settles, and <code>cacheTracing()</code> turns it into a{" "}
        <code>cache &lt;op&gt;</code> span with the outcome (<code>hit</code>, <code>stale</code>,{" "}
        <code>miss</code>). Keys often hold ids or emails, so a span carries only the key prefix (
        <code>orders:recent</code> gives <code>orders</code>) unless you choose otherwise. A stale
        read's background refresh outlives the request, so it is its own trace, linked to the request
        span.
      </p>
      <p>
        <code>jobTracing()</code> follows the OpenTelemetry messaging conventions: a{" "}
        <code>send &lt;job&gt;</code> producer span per enqueue, whose context is stored with the job,
        and a <code>process &lt;job&gt;</code> consumer span per attempt. The process span is a child
        of the send span, plus a link to it, so one trace runs from the request to the worker even when
        the worker is another process. Retries are separate spans, and the attempt that dead-letters a
        job says so. A job store persists the trace context as an optional field;{" "}
        <code>jobStoreCertificationProfile(&#123; traceparent: true &#125;)</code> checks it.
      </p>

      <h2>Event consumers</h2>
      <CodeBlock code={EVENTS} lang="ts" />
      <p>
        nifra defines event contracts but does not deliver events, so it cannot trace them on its own.
        One wrapper does: each envelope gets a consumer span linked to the producer through its
        causality, and input that fails to parse becomes an error span that carries an issue count,
        never the payload.
      </p>

      <h2>The OpenTelemetry SDK bridge</h2>
      <CodeBlock code={BRIDGE} lang="ts" />
      <p>
        The SDK's instrumentations for pg, mysql2, ioredis, undici and prisma read the active span
        from the OpenTelemetry context. <code>bridge.plugin</code> puts the request span there with
        one <code>around()</code> frame per request, <code>bridge.scope</code> does the same for job
        and event handlers, and <code>bridge.adapter</code> mirrors nifra's spans into the SDK so one
        pipeline exports everything. The app passes its own <code>@opentelemetry/api</code>;{" "}
        <code>@nifrajs/otel</code> takes no dependency on it.
      </p>
      <p>
        Context propagation was checked on Node 26, Bun 1.4, Deno 2.9 and workerd with{" "}
        <code>nodejs_compat</code>: a span started in a handler after an <code>await</code> is a child
        of the request span on all four. The SDK's undici instrumentation records <code>fetch</code>{" "}
        only on Node, where <code>fetch</code> is undici.
      </p>

      <h2>One trace, end to end</h2>
      <p>
        <code>GET /orders</code> reads through the cache, enqueues a job into a Postgres-backed store,
        and a separate worker process runs it. In Jaeger it is one trace:
      </p>
      <CodeBlock code={TRACE} lang="text" />
      <p>
        The cache span is reported after the loader settles, so the loader's own query is the request
        span's child, next to the cache span rather than under it.
      </p>

      <h2>What stays out</h2>
      <p>
        No span carries a request body, a job payload, an event payload, a raw cache key or error text.
        Without a tracer configured, the cache and the queue run the code they ran before: no clock
        reads, no events, no extra frames.
      </p>
    </div>
  )
}
