import { cpus } from "node:os"
import { performance } from "node:perf_hooks"
import { t } from "@nifrajs/schema"
import { createWebApp, type Manifest, MemoryCacheStore, withISR } from "@nifrajs/web"
import {
  createServerComponents,
  defineServerComponent,
  serverComponentInstance,
} from "@nifrajs/web/server-components"
import {
  ISR_REVALIDATE_HEADER,
  type ISRApp,
  OWNER_CACHEABLE_HEADER,
  SERVER_COMPONENT_CACHE_PARTITION,
} from "../packages/web/src/isr.ts"
import {
  COMPONENT_FLIGHT_MEDIA_TYPE,
  componentRequestHeader,
} from "../packages/web/src/server-components/protocol.ts"
import {
  encodeComponentBytes,
  readComponentBytes,
} from "../packages/web/src/server-components/stream.ts"

const percentile = (values: readonly number[], ratio: number): number =>
  [...values].sort((left, right) => left - right)[Math.ceil(values.length * ratio) - 1] ?? 0

const component = defineServerComponent(
  {
    input: t.object({}),
    props: t.object({ value: t.string() }),
    authorize() {},
    load: () => ({ value: "public" }),
    view: ({ props }) => props.value,
  },
  "cache_benchmark_component",
)
const serverComponents = createServerComponents({
  build: "cache-benchmark-build",
  deployment: "cache-benchmark-deployment",
  adapter: {
    name: "react",
    version: 1,
    render(_view, props) {
      const value =
        typeof props === "object" && props !== null ? Reflect.get(props, "value") : undefined
      return { html: `<p>${typeof value === "string" ? value : "invalid"}</p>` }
    },
    renderProgressive() {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('0:"progressive"\n'))
          controller.close()
        },
      })
    },
  },
  owners: {
    owner: {
      cache: { scope: "public", requestIndependent: true, revalidate: 60 },
      components: [component],
      scope: "anonymous",
      instances: () => [serverComponentInstance(component, "stable", {})],
    },
    ownerNoCachePolicy: {
      components: [component],
      scope: "anonymous",
      instances: () => [serverComponentInstance(component, "stable", {})],
    },
  },
})
const manifest: Manifest = {
  routes: [
    {
      id: "owner",
      pattern: "/owner",
      file: "owner.ts",
      layoutIds: [],
      errorIds: [],
      middlewareIds: [],
      load: async () => ({ default: () => null, loader: () => ({}) }),
    },
    {
      id: "plain",
      pattern: "/plain",
      file: "plain.ts",
      layoutIds: [],
      errorIds: [],
      middlewareIds: [],
      load: async () => ({ default: () => null, loader: () => ({}) }),
    },
    {
      id: "ownerNoCachePolicy",
      pattern: "/owner-no-cache-policy",
      file: "owner-no-cache-policy.ts",
      layoutIds: [],
      errorIds: [],
      middlewareIds: [],
      load: async () => ({ default: () => null, loader: () => ({}) }),
    },
  ],
  layouts: {},
  middlewares: {},
  errors: {},
}
const app = createWebApp({
  manifest,
  clientEntry: "/entry.js",
  llmsTxt: false,
  serverComponents,
  adapter: {
    renderToString: () => "<main>blocking</main>",
    renderToStream: () =>
      new ReadableStream({
        start(controller) {
          controller.close()
        },
      }),
    hydrationHead: () => "",
  },
})
const store = new MemoryCacheStore()
const ownerCacheSource: ISRApp = {
  async fetch() {
    return new Response("<main>public owner</main>", {
      headers: {
        "cache-control": "private, no-store",
        "content-type": "text/html; charset=utf-8",
        [OWNER_CACHEABLE_HEADER]: "1",
        [ISR_REVALIDATE_HEADER]: "60",
      },
    })
  },
}
Object.defineProperty(ownerCacheSource, SERVER_COMPONENT_CACHE_PARTITION, {
  value: () => "cache-benchmark-deployment-build-owner",
})
const cachedOwnerApp = withISR(ownerCacheSource, { store, revalidate: 60, now: () => 0 })

const consume = async (response: Response, cacheStatus?: "miss" | "hit"): Promise<void> => {
  if (response.status !== 200) throw new Error(`Unexpected ${response.status} response`)
  if (cacheStatus !== undefined && response.headers.get("x-nifra-isr") !== cacheStatus)
    throw new Error(
      `Expected ISR ${cacheStatus}, got ${response.headers.get("x-nifra-isr")}; ` +
        `cache-control=${response.headers.get("cache-control")}; ` +
        `owner-cacheable=${response.headers.get("x-nifra-owner-cacheable")}; ` +
        `revalidate=${response.headers.get("x-nifra-isr-revalidate")}; ` +
        `vary=${response.headers.get("vary")}; ` +
        `content-type=${response.headers.get("content-type")}`,
    )
  await response.arrayBuffer()
}

const measure = async (
  call: (index: number) => Promise<Response>,
  expectedCacheStatus?: "miss" | "hit",
): Promise<{
  p50Ms: number
  p95Ms: number
  requestsPerSecond: number
  cpuMicrosecondsPerRequest: number
  rssStartBytes: number
  sampledPeakRssBytes: number
  sampledPeakRssDeltaBytes: number
}> => {
  for (let index = 0; index < 30; index += 1) await consume(await call(index), expectedCacheStatus)
  const rssStartBytes = process.memoryUsage.rss()
  let sampledPeakRssBytes = rssStartBytes
  const cpuStart = process.cpuUsage()
  const started = performance.now()
  const durations: number[] = []
  const samples = 2_000
  const concurrency = 16
  const sampleRss = () => {
    sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage.rss())
  }
  const sampler = setInterval(sampleRss, 5)
  let nextIndex = 0
  try {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (;;) {
          const index = nextIndex++
          if (index >= samples) return
          const requestStarted = performance.now()
          await consume(await call(index), expectedCacheStatus)
          durations.push(performance.now() - requestStarted)
          sampleRss()
        }
      }),
    )
  } finally {
    clearInterval(sampler)
  }
  sampleRss()
  const elapsedMs = performance.now() - started
  const cpu = process.cpuUsage(cpuStart)
  return {
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    requestsPerSecond: (samples * 1000) / elapsedMs,
    cpuMicrosecondsPerRequest: (cpu.user + cpu.system) / durations.length,
    rssStartBytes,
    sampledPeakRssBytes,
    sampledPeakRssDeltaBytes: Math.max(0, sampledPeakRssBytes - rssStartBytes),
  }
}

const measureFlightSnapshot = async () => {
  const inputBytes = 1_048_576
  const concurrency = 4
  const samples = 64
  const flightBytes = new Uint8Array(inputBytes)
  flightBytes.fill(120)
  const snapshot = async (): Promise<number> => {
    const flight = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(flightBytes)
        controller.close()
      },
    })
    const [renderStream, snapshotStream] = flight.tee()
    const signal = new AbortController().signal
    const [renderBytes, snapshotBytes] = await Promise.all([
      readComponentBytes(renderStream, signal),
      readComponentBytes(snapshotStream, signal),
    ])
    if (renderBytes.byteLength !== inputBytes) throw new Error("Flight render branch was truncated")
    return encodeComponentBytes(snapshotBytes).length
  }
  for (let index = 0; index < 4; index += 1) await snapshot()
  const rssStartBytes = process.memoryUsage.rss()
  let sampledPeakRssBytes = rssStartBytes
  const sampleRss = () => {
    sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage.rss())
  }
  const sampler = setInterval(sampleRss, 5)
  const cpuStart = process.cpuUsage()
  const started = performance.now()
  const durations: number[] = []
  let nextIndex = 0
  try {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (;;) {
          const index = nextIndex++
          if (index >= samples) return
          const requestStarted = performance.now()
          const outputBytes = await snapshot()
          if (outputBytes !== Math.ceil(inputBytes / 3) * 4)
            throw new Error(`Unexpected base64 size: ${outputBytes}`)
          durations.push(performance.now() - requestStarted)
          sampleRss()
        }
      }),
    )
  } finally {
    clearInterval(sampler)
  }
  sampleRss()
  const elapsedMs = performance.now() - started
  const cpu = process.cpuUsage(cpuStart)
  return {
    inputBytes,
    outputBase64Bytes: Math.ceil(inputBytes / 3) * 4,
    samples,
    concurrency,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    operationsPerSecond: (samples * 1000) / elapsedMs,
    cpuMicrosecondsPerOperation: (cpu.user + cpu.system) / durations.length,
    rssStartBytes,
    sampledPeakRssBytes,
    sampledPeakRssDeltaBytes: Math.max(0, sampledPeakRssBytes - rssStartBytes),
    scope:
      "Flight tee, two bounded snapshots and base64 only; excludes React Flight parsing and DOM commit",
  }
}

let missKey = 0
const componentSelection = componentRequestHeader({
  v: 1,
  build: "cache-benchmark-build",
  reference: "cache_benchmark_component",
  key: "stable",
  parent: null,
  generation: 1,
  routeEpoch: 0,
  authEpoch: 0,
  input: {},
})
const componentRequest = (index: number, progressive: boolean, path = "/owner") => {
  const headers = new Headers({
    "sec-fetch-site": "same-origin",
    "x-nifra-component": componentSelection,
  })
  if (progressive) headers.set("accept", COMPONENT_FLIGHT_MEDIA_TYPE)
  return new Request(`https://fixture.test${path}?component=${index}`, { headers })
}

const modes: Record<string, (index: number) => Promise<Response>> = {
  blockingSsr: async (index: number) =>
    app.fetch(new Request(`https://fixture.test/plain?sample=${index}`)),
  bufferedComponentRecord: async (index: number) => app.fetch(componentRequest(index, false)),
  progressiveComponentFlight: async (index: number) => app.fetch(componentRequest(index, true)),
  ownerWithoutCachePolicy: async (index: number) =>
    app.fetch(componentRequest(index, false, "/owner-no-cache-policy")),
  ownerWithoutIsr: async (index: number) =>
    app.fetch(new Request(`https://fixture.test/owner?sample=${index}`)),
  ownerCacheMiss: (_index: number) =>
    cachedOwnerApp(new Request(`https://fixture.test/synthetic-owner/${missKey++}`)),
  ownerCacheHit: (_index) =>
    cachedOwnerApp(new Request("https://fixture.test/synthetic-owner/hit")),
}

const results: Record<string, Awaited<ReturnType<typeof measure>>> = {}
for (const [name, call] of Object.entries(modes)) {
  const cacheStatus =
    name === "ownerCacheMiss" ? "miss" : name === "ownerCacheHit" ? "hit" : undefined
  if (name === "ownerCacheHit") await consume(await call(-1), "miss")
  results[name] = await measure(call, cacheStatus)
}
const flightSnapshot = await measureFlightSnapshot()

console.log(
  JSON.stringify(
    {
      status: "measured",
      runtime: `Bun ${Bun.version}`,
      cpu: cpus()[0]?.model ?? "unknown",
      samplesPerMode: 2_000,
      warmupsPerMode: 30,
      concurrency: 16,
      memory: "RSS sampled every 5 ms and after responses; not an allocator high-water mark",
      ownerCache:
        "ownerWithoutCachePolicy measures a real owner refresh whose route declares no cache policy; ownerWithoutIsr measures a configured cacheable owner route without the ISR wrapper. The ownerCacheMiss and ownerCacheHit modes use a synthetic ISR response with the owner cache headers and partition key.",
      ppr: "Run `bun run bench:ppr` for PPR, blocking SSR and defer() throughput/CPU measurements.",
      flightSnapshot,
      results,
    },
    null,
    2,
  ),
)
