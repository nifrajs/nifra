/**
 * The OTel SDK context bridge on **Node itself**, with the SDK's own undici instrumentation: a `fetch`
 * made inside a nifra handler must become a child of the nifra request span, both through `app.fetch`
 * and through the `@nifrajs/node` server.
 */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import test from "node:test"
import { server } from "@nifrajs/core"
import { serve } from "@nifrajs/node"
import { type NifraSpan, tracing } from "@nifrajs/otel"
import { otelBridge } from "@nifrajs/otel/sdk-bridge"
import * as api from "@opentelemetry/api"
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks"
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici"
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"

// `bun test packages/otel/test` also collects this directory; Bun's fetch is not undici, so these
// checks (and the global SDK registration) run on Node only.
const onNode = !("Bun" in globalThis)
const skip = onNode ? false : "Node only: the SDK's undici instrumentation needs Node's fetch"

const bridge = otelBridge({ api })
const exporter = new InMemorySpanExporter()
let upstreamUrl = ""

if (onNode) {
  const provider = new BasicTracerProvider({
    idGenerator: bridge.idGenerator,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
  api.trace.setGlobalTracerProvider(provider)
  api.context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  const undici = new UndiciInstrumentation()
  undici.setTracerProvider(provider)
  undici.enable()
  const upstream = createServer((_req, res) => res.end("ok"))
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/inventory`
  test.after(() => {
    undici.disable()
    upstream.close()
  })
}

function app(spans: NifraSpan[]) {
  return server()
    .use(tracing({ exporter: { onEnd: (span) => spans.push(span) }, adapters: [bridge.adapter] }))
    .use(bridge.plugin)
    .get("/orders", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      const res = await fetch(upstreamUrl)
      return { upstream: await res.text() }
    })
}

function assertNested(spans: readonly NifraSpan[]): void {
  const request = spans.find((span) => span.name === "GET /orders")
  assert.ok(request, "nifra request span")
  const client = exporter
    .getFinishedSpans()
    .find((span) => span.attributes["url.full"] === upstreamUrl)
  assert.ok(client, "undici instrumentation span")
  assert.equal(client.spanContext().traceId, request.traceId)
  assert.equal(client.parentSpanContext?.spanId, request.spanId)
  const mirrored = exporter
    .getFinishedSpans()
    .find((span) => span.spanContext().spanId === request.spanId)
  assert.equal(mirrored?.name, "GET /orders", "mirrored request span keeps the nifra ids")
}

test("an undici fetch inside a handler nests under the request span (app.fetch)", {
  skip,
}, async () => {
  exporter.reset()
  const spans: NifraSpan[] = []
  const res = await app(spans).fetch(new Request("http://nifra.test/orders"))
  assert.deepEqual(await res.json(), { upstream: "ok" })
  assertNested(spans)
})

test("an undici fetch inside a handler nests under the request span (@nifrajs/node)", {
  skip,
}, async () => {
  exporter.reset()
  const spans: NifraSpan[] = []
  const running = await serve(app(spans), { port: 0, hostname: "127.0.0.1" })
  try {
    const res = await fetch(`http://127.0.0.1:${running.port}/orders`)
    assert.deepEqual(await res.json(), { upstream: "ok" })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assertNested(spans)
  } finally {
    await running.stop({ drainMs: 0 })
  }
})
