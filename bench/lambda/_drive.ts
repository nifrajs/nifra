/**
 * Shared driver + event fixtures for the Lambda adapter benchmark. Each framework's entry file
 * (handler-*.ts) does its own STATIC imports, builds its handler, and hands the builder here.
 *
 * Why the entry files own the imports: Lambda charges an INIT phase - process start through the
 * moment your handler is ready - and the dominant term in it is how much JavaScript the runtime
 * has to parse and execute before that point. A dynamic `import()` inside a shared driver would
 * move that cost out of the measurement and make every framework look identical. Static imports in
 * a per-framework bundle are also exactly how a Lambda deploy is shipped.
 *
 * `initMs` is `performance.now()` read on the first line of the entry's main - and Node sets
 * `performance.timeOrigin` at process start, so it already contains runtime boot + bundle parse +
 * module init. The `raw` row imports nothing, so its `initMs` is this box's floor; the interesting
 * number for any framework is its distance from that floor, not the absolute.
 */

export interface LambdaEventFixture {
  readonly rawPath: string
  readonly rawQueryString: string
  readonly headers: Record<string, string>
  readonly body?: string
  readonly isBase64Encoded: boolean
  readonly requestContext: { readonly http: { readonly method: string } }
}

export const GET_EVENT: LambdaEventFixture = {
  rawPath: "/users/123",
  rawQueryString: "",
  headers: { host: "bench.example" },
  isBase64Encoded: false,
  requestContext: { http: { method: "GET" } },
}

export const POST_EVENT: LambdaEventFixture = {
  rawPath: "/users",
  rawQueryString: "",
  headers: { host: "bench.example", "content-type": "application/json" },
  body: JSON.stringify({ name: "Ada", age: 36 }),
  isBase64Encoded: false,
  requestContext: { http: { method: "POST" } },
}

/** The one predicate every framework's POST branch shares, so the rows validate identical
 *  semantics and only the adapter's plumbing differs. */
export function isUser(v: unknown): v is { name: string; age: number } {
  return (
    typeof v === "object" &&
    v !== null &&
    "name" in v &&
    typeof v.name === "string" &&
    "age" in v &&
    typeof v.age === "number"
  )
}

type Invoke = (event: LambdaEventFixture) => Promise<{ statusCode: number }>

const WARM_ITERATIONS = 2_000

/**
 * Run one framework's row. `mode` comes from argv:
 *   cold - build the handler, invoke it ONCE, print init/build/first-invoke and exit. Meaningful
 *          only in a fresh process, so run.ts spawns one per sample.
 *   warm - build, discard a warmup burst so the JIT has tiered up, then time N invocations and
 *          report the MEDIAN (robust to a background CPU spike) plus invocations/sec.
 */
export async function drive(framework: string, initMs: number, build: () => Invoke): Promise<void> {
  const mode = process.argv[2]

  const buildStart = performance.now()
  const invoke = build()
  const buildMs = performance.now() - buildStart

  if (mode === "cold") {
    const invokeStart = performance.now()
    const result = await invoke(GET_EVENT)
    const firstInvokeMs = performance.now() - invokeStart
    if (result.statusCode !== 200) throw new Error(`${framework}: cold invoke was not 200`)
    console.log(
      JSON.stringify({
        framework,
        initMs,
        buildMs,
        firstInvokeMs,
        coldMs: initMs + buildMs + firstInvokeMs,
      }),
    )
    return
  }

  if (mode === "warm") {
    for (const event of [GET_EVENT, POST_EVENT]) {
      for (let i = 0; i < 500; i++) await invoke(event)
    }
    const out: Record<string, number> = {}
    for (const [name, event] of [
      ["GET /users/:id", GET_EVENT],
      ["POST /users", POST_EVENT],
    ] as const) {
      const samples: number[] = []
      for (let i = 0; i < WARM_ITERATIONS; i++) {
        const t0 = performance.now()
        const result = await invoke(event)
        samples.push(performance.now() - t0)
        if (result.statusCode !== 200) throw new Error(`${framework}: warm invoke was not 200`)
      }
      samples.sort((a, b) => a - b)
      out[name] = samples[samples.length >> 1] ?? 0
    }
    console.log(JSON.stringify({ framework, warmMedianMs: out }))
    return
  }

  throw new Error(`usage: node <bundle> <cold|warm>`)
}
