import { describe, expect, test } from "bun:test"
import { richWireCodec } from "@nifrajs/core/transport-codec-rich"
import {
  defer,
  MAP_DEFERRED_SOURCE,
  ndjsonStream,
  parseNdjsonData,
  prepareDeferred,
} from "../src/deferred.ts"

// DEFERRED_RUNTIME is exercised via the render tests.

describe("defer + prepareDeferred", () => {
  test("defer wraps a promise as a deferred marker", () => {
    const p = Promise.resolve(1)
    const d = defer(p)
    expect(d.__nifra_deferred).toBe(true)
    expect(d.promise).toBe(p)
  })

  test("claims an eager rejection before a deferred consumer attaches", async () => {
    const code = `
      import { defer } from ${JSON.stringify(new URL("../src/deferred.ts", import.meta.url).href)}
      const promise = Promise.reject(new Error("eager deferred rejection"))
      const marker = defer(promise)
      if (marker.promise !== promise) process.exit(2)
      await Bun.sleep(10)
    `
    const proc = Bun.spawn([process.execPath, "--eval", code], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
  })

  test("splits resolved keys from deferred: client placeholders + component markers with ids", () => {
    const p1 = Promise.resolve("a")
    const p2 = Promise.resolve("b")
    const { forComponent, forClient, deferred } = prepareDeferred({
      now: 1,
      x: defer(p1),
      y: defer(p2),
    })
    // Client (serialized) gets numeric-id placeholders — no promises.
    expect(forClient).toEqual({ now: 1, x: { __nifra_deferred: 0 }, y: { __nifra_deferred: 1 } })
    // Component gets markers carrying the assigned id + the original promise (same reference).
    const comp = forComponent as Record<string, unknown>
    expect(comp.now).toBe(1)
    expect(comp.x).toEqual({ __nifra_deferred: true, id: 0, promise: p1 })
    expect(deferred).toHaveLength(2)
    expect(deferred[0]?.id).toBe(0)
    expect(deferred[0]?.promise).toBe(p1)
    expect(deferred[1]?.promise).toBe(p2)
  })

  test("a plain object (no defer) is returned BY REFERENCE — no clone (structural sharing) [AUDIT Perf-8]", () => {
    // hits isDeferred's three negative branches: primitive, null-free object without the flag.
    const input = { a: 1, b: { nested: true } }
    const { forComponent, forClient, deferred } = prepareDeferred(input)
    expect(forClient).toEqual({ a: 1, b: { nested: true } })
    expect(deferred).toEqual([])
    // Deferred-free data isn't deep-cloned into two trees — both sides ARE the original input.
    expect(forComponent).toBe(input)
    expect(forClient).toBe(input)
  })

  test("ignores inherited enumerable deferred markers like Object.entries did", () => {
    const proto = { slow: defer(Promise.resolve("inherited")) }
    const input = Object.assign(Object.create(proto) as { now: number; slow?: unknown }, { now: 1 })
    const { forComponent, forClient, deferred } = prepareDeferred(input)
    expect(deferred).toEqual([])
    expect(forComponent).toBe(input)
    expect(forClient).toBe(input)
    expect(Object.hasOwn(forClient as object, "slow")).toBe(false)
  })

  test("non-deferred data (null/primitive/plain arrays) round-trips through the recursive walk", () => {
    expect(prepareDeferred(null)).toEqual({ forComponent: null, forClient: null, deferred: [] })
    expect(prepareDeferred("hi").forClient).toBe("hi")
    expect(prepareDeferred([1, 2]).forClient).toEqual([1, 2])
    expect(prepareDeferred([1, 2]).deferred).toEqual([])
  })

  test("finds defer() nested in objects + arrays (recursive, ids in walk order)", () => {
    const p0 = Promise.resolve("a")
    const p1 = Promise.resolve("b")
    const p2 = Promise.resolve("c")
    const { forComponent, forClient, deferred } = prepareDeferred({
      top: defer(p0),
      panels: [{ chart: defer(p1) }, { plain: 1 }],
      meta: { feed: defer(p2) },
    })
    expect(deferred).toHaveLength(3)
    // Placeholders at any depth; ids assigned in walk order (top=0, panels[0].chart=1, meta.feed=2).
    expect(forClient).toEqual({
      top: { __nifra_deferred: 0 },
      panels: [{ chart: { __nifra_deferred: 1 } }, { plain: 1 }],
      meta: { feed: { __nifra_deferred: 2 } },
    })
    // Component-facing markers carry the original promise (same reference) at depth.
    const fc = forComponent as { panels: Array<{ chart?: { promise: Promise<unknown> } }> }
    expect(fc.panels[0]?.chart?.promise).toBe(p1)
    expect(deferred[1]?.promise).toBe(p1)
  })

  test("nested defer round-trips through ndjsonStream → parseNdjsonData (markers settle at depth)", async () => {
    const { forClient, deferred } = prepareDeferred({
      panels: [{ chart: defer(Promise.resolve([1, 2, 3])) }],
      meta: { feed: defer(Promise.resolve("nf")) },
    })
    const data = (await parseNdjsonData(ndjsonStream(forClient, deferred))) as {
      panels: Array<{ chart: { __nifra_deferred: true; promise: Promise<unknown> } }>
      meta: { feed: { promise: Promise<unknown> } }
    }
    expect(data.panels[0]?.chart.__nifra_deferred).toBe(true)
    expect(await data.panels[0]?.chart.promise).toEqual([1, 2, 3])
    expect(await data.meta.feed.promise).toBe("nf")
  })

  test("MAP_DEFERRED_SOURCE (client codegen) maps placeholders to registry promises at any depth", () => {
    const calls: number[] = []
    const win = {
      __nifraDeferred: (id: number) => {
        calls.push(id)
        return `P${id}`
      },
    }
    // The emitted source defines `const mapDeferred = …` reading `window.__nifraDeferred`.
    const mapDeferred = new Function("window", `${MAP_DEFERRED_SOURCE}; return mapDeferred`)(
      win,
    ) as (d: unknown) => Record<string, unknown>
    const out = mapDeferred({
      top: { __nifra_deferred: 0 },
      panels: [{ chart: { __nifra_deferred: 1 } }],
      plain: 5,
    })
    expect(out.top).toEqual({ __nifra_deferred: true, id: 0, promise: "P0" })
    expect((out.panels as Array<{ chart: unknown }>)[0]?.chart).toEqual({
      __nifra_deferred: true,
      id: 1,
      promise: "P1",
    })
    expect(out.plain).toBe(5)
    expect(calls).toEqual([0, 1]) // both nested placeholders resolved via the registry
  })

  test("idOffset continues the id space — data + action deferred share one registry, no collision", () => {
    // A full-page POST splits BOTH the loader data and the action result into one client registry;
    // the action split offsets its ids past the data's so they don't collide.
    const dataSplit = prepareDeferred({ feed: defer(Promise.resolve("d")) })
    const actionSplit = prepareDeferred(
      { receipt: defer(Promise.resolve("a")) },
      dataSplit.deferred.length,
    )
    expect(dataSplit.forClient).toEqual({ feed: { __nifra_deferred: 0 } })
    expect(actionSplit.forClient).toEqual({ receipt: { __nifra_deferred: 1 } }) // offset → 1, not 0
    expect(actionSplit.deferred[0]?.id).toBe(1)
  })
})

// A rejecting deferred. `ndjsonStream` handles it correctly (redacts, streams the opaque code — the
// assertions below prove it), but Bun still reports the rejection "unhandled" at PROCESS EXIT, which
// makes `bun test` exit nonzero with 0 test failures.
//
// This was diagnosed to a Bun runtime bug, NOT a code defect (2026-07-24): the rejection IS handled —
// via `.then`/`await` inside the stream — but Bun mis-flags it whenever the handled promise is consumed
// CONCURRENTLY (`Promise.all(...map(async …))`, or a floated `.then`). A strictly SEQUENTIAL `for-await`
// is the only shape Bun doesn't flag, and switching to it would regress the deliberate out-of-order
// deferred streaming (AUDIT H1) — a real feature traded for a cosmetic exit code, so it is NOT done. The
// reject timing (`setTimeout` vs eager vs microtask) makes no difference; neither does a pre-attached
// `.catch`, a process `unhandledRejection` handler, or `--unhandled-rejections=warn`. Production is
// unaffected: a server never exits, so the exit-time report never fires. Left as-is deliberately; do not
// "fix" it by sequentializing the stream.
function rejection(message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), 1)
  })
}

// Read an NDJSON ReadableStream to an array of text lines (for asserting ndjsonStream's output).
async function readLines(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const text = await new Response(stream).text()
  return text.split("\n").filter((l) => l !== "")
}

describe("ndjsonStream (server soft-nav transport)", () => {
  test("emits line 1 (placeholders) then a resolve/reject line per deferred", async () => {
    const { forClient, deferred } = prepareDeferred({
      now: 1,
      ok: defer(Promise.resolve(["a", "b"])),
      bad: defer(rejection("upstream failed")),
    })
    const lines = (await readLines(ndjsonStream(forClient, deferred))).map((l) => JSON.parse(l))
    expect(lines[0]).toEqual({ now: 1, ok: { __nifra_deferred: 0 }, bad: { __nifra_deferred: 1 } })
    // ids 0 + 1 each get a settle line (order is by settle time, so match by id)
    const byId = new Map(lines.slice(1).map((m) => [m.i, m]))
    expect(byId.get(0)).toEqual({ i: 0, v: ["a", "b"] })
    // Rejection is data, not a stream error — and REDACTED: the opaque code, never the raw reason
    // ("upstream failed" is logged server-side, not leaked to the client). [AUDIT H3]
    expect(byId.get(1)).toEqual({ i: 1, e: "deferred_error" })
    expect(JSON.stringify(lines)).not.toContain("upstream failed")
  })
})

describe("parseNdjsonData (client soft-nav transport)", () => {
  // Build an NDJSON stream from explicit text chunks (with optional delay) to drive the parser.
  const streamOf = (
    chunks: Array<{ text: string; delay?: number }>,
  ): ReadableStream<Uint8Array> => {
    const enc = new TextEncoder()
    return new ReadableStream({
      async start(c) {
        for (const { text, delay } of chunks) {
          if (delay) await new Promise((r) => setTimeout(r, delay))
          c.enqueue(enc.encode(text))
        }
        c.close()
      },
    })
  }
  const asMarker = (v: unknown) =>
    v as { __nifra_deferred: true; id: number; promise: Promise<unknown> }

  test("round-trips ndjsonStream: data after line 1, markers settle as lines arrive", async () => {
    const { forClient, deferred } = prepareDeferred({
      now: 2,
      feed: defer(Promise.resolve("late")),
    })
    const data = (await parseNdjsonData(ndjsonStream(forClient, deferred))) as Record<
      string,
      unknown
    >
    expect(data.now).toBe(2)
    expect(asMarker(data.feed).__nifra_deferred).toBe(true)
    expect(await asMarker(data.feed).promise).toBe("late")
  })

  test("a reject line rejects the marker; line 1 parses across a chunk split", async () => {
    const data = (await parseNdjsonData(
      streamOf([
        { text: '{"feed":{"__nifra_def' },
        { text: 'erred":0}}\n', delay: 5 },
        { text: '{"i":0,"e":"boom"}\n', delay: 5 },
      ]),
    )) as Record<string, unknown>
    await expect(asMarker(data.feed).promise).rejects.toThrow("boom")
  })

  test("a truncated stream rejects the unsettled marker (no hang)", async () => {
    const data = (await parseNdjsonData(
      streamOf([{ text: '{"feed":{"__nifra_deferred":0}}\n' }]),
    )) as Record<string, unknown>
    await expect(asMarker(data.feed).promise).rejects.toThrow(/ended before/)
  })

  test("non-deferred body (no placeholders) parses to plain data", async () => {
    const data = await parseNdjsonData(streamOf([{ text: '{"count":5}\n' }]))
    expect(data).toEqual({ count: 5 })
  })

  test("an aborted stream leaves markers pending (a superseded nav — no error flash)", async () => {
    const ac = new AbortController()
    const data = (await parseNdjsonData(
      streamOf([
        { text: '{"feed":{"__nifra_deferred":0}}\n' },
        { text: '{"i":0,"v":"too late"}\n', delay: 200 },
      ]),
      ac.signal,
    )) as Record<string, unknown>
    ac.abort() // a newer navigation abandons this stream — markers detach, not error
    const outcome = await Promise.race([
      asMarker(data.feed).promise.then(
        () => "settled",
        () => "rejected",
      ),
      new Promise<string>((r) => setTimeout(() => r("pending"), 60)),
    ])
    expect(outcome).toBe("pending") // neither settled nor rejected (detached + GC'd, no flash)
  })

  test("duplicate placeholder ids in line 1 alias one promise — neither marker leaks [AUDIT L2]", async () => {
    const data = (await parseNdjsonData(
      streamOf([
        { text: '{"a":{"__nifra_deferred":0},"b":{"__nifra_deferred":0}}\n' }, // same id twice
        { text: '{"i":0,"v":"shared"}\n', delay: 5 },
      ]),
    )) as { a: { promise: Promise<unknown> }; b: { promise: Promise<unknown> } }
    // The repeated id aliases ONE promise; a single resolve line settles both (no never-settling
    // first marker). With the old overwrite, `a`'s promise would hang forever.
    expect(data.a.promise).toBe(data.b.promise)
    expect(await data.a.promise).toBe("shared")
    expect(await data.b.promise).toBe("shared")
  })

  test("removes its abort listener once the stream completes — no listener accumulation [AUDIT L3]", async () => {
    const ac = new AbortController()
    let added = 0
    let removed = 0
    let once = false
    // Spy via the method's own parameter tuple (`Parameters<>`) so we don't name DOM-lib types this
    // package's tsconfig doesn't load. args[0] is the event type; args[2] is the options.
    const realAdd = ac.signal.addEventListener.bind(ac.signal)
    const realRemove = ac.signal.removeEventListener.bind(ac.signal)
    ac.signal.addEventListener = ((...args: Parameters<typeof ac.signal.addEventListener>) => {
      if (args[0] === "abort") {
        added++
        const opts = args[2]
        if (typeof opts === "object" && opts?.once === true) once = true
      }
      return realAdd(...args)
    }) as typeof ac.signal.addEventListener
    ac.signal.removeEventListener = ((
      ...args: Parameters<typeof ac.signal.removeEventListener>
    ) => {
      if (args[0] === "abort") removed++
      return realRemove(...args)
    }) as typeof ac.signal.removeEventListener
    const data = await parseNdjsonData(streamOf([{ text: '{"count":5}\n' }]), ac.signal)
    await new Promise((r) => setTimeout(r, 5)) // let the background drain run its finally
    expect(data).toEqual({ count: 5 })
    expect(added).toBe(1)
    expect(once).toBe(true) // registered with { once: true }
    expect(removed).toBe(1) // and explicitly removed on completion (reused-signal safety)
  })

  test("uses the shared rich transport codec for critical and deferred loader values", async () => {
    const codec = richWireCodec()
    const prepared = prepareDeferred({
      at: new Date("2026-01-01T00:00:00.000Z"),
      later: defer(Promise.resolve(9n)),
    })
    const data = (await parseNdjsonData(
      ndjsonStream(prepared.forClient, prepared.deferred, codec),
      undefined,
      codec,
    )) as { at: Date; later: { promise: Promise<bigint> } }

    expect(data.at).toBeInstanceOf(Date)
    expect(await data.later.promise).toBe(9n)
  })
})
