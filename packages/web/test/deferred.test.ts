import { describe, expect, spyOn, test } from "bun:test"
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
    // Client (serialized) gets numeric-id placeholders - no promises.
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

  test("a plain object (no defer) is returned BY REFERENCE - no clone (structural sharing)", () => {
    // hits isDeferred's three negative branches: primitive, null-free object without the flag.
    const input = { a: 1, b: { nested: true } }
    const { forComponent, forClient, deferred } = prepareDeferred(input)
    expect(forClient).toEqual({ a: 1, b: { nested: true } })
    expect(deferred).toEqual([])
    // Deferred-free data isn't deep-cloned into two trees - both sides ARE the original input.
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

  test("idOffset continues the id space - data + action deferred share one registry, no collision", () => {
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

  test("an own __proto__ key on a rebuilt object stays data, in either key order and nested", () => {
    const cases = [
      '{"__proto__":{"isAdmin":true},"later":0}',
      '{"later":0,"__proto__":{"isAdmin":true}}',
      '{"outer":{"__proto__":{"isAdmin":true},"later":0}}',
      '{"outer":{"later":0,"__proto__":{"isAdmin":true}}}',
    ]
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null
    for (const json of cases) {
      const input: Record<string, unknown> & { outer?: Record<string, unknown> } = JSON.parse(json)
      const nested = input.outer !== undefined
      const holder = input.outer ?? input
      holder.later = defer(Promise.resolve(1))
      const { forComponent, forClient } = prepareDeferred(input)
      for (const out of [forComponent, forClient]) {
        const rebuilt = isRecord(out) && nested ? out.outer : out
        if (!isRecord(rebuilt)) throw new Error("expected the rebuilt object")
        expect(Object.getPrototypeOf(rebuilt)).toBe(Object.prototype)
        expect(Object.hasOwn(rebuilt, "__proto__")).toBe(true)
        expect(rebuilt.isAdmin).toBeUndefined()
        expect(Object.keys(rebuilt)).toEqual(Object.keys(holder))
      }
      expect(JSON.stringify(forClient)).toContain('"__proto__":{"isAdmin":true}')
    }
  })
})

// A rejecting deferred. `ndjsonStream` handles it correctly (redacts, streams the opaque code - the
// assertions below prove it), but Bun still reports the rejection "unhandled" at PROCESS EXIT, which
// makes `bun test` exit nonzero with 0 test failures.
//
// This was diagnosed to a Bun runtime bug, NOT a code defect (2026-07-24): the rejection IS handled -
// via `.then`/`await` inside the stream - but Bun mis-flags it whenever the handled promise is consumed
// CONCURRENTLY (`Promise.all(...map(async …))`, or a floated `.then`). A strictly SEQUENTIAL `for-await`
// is the only shape Bun doesn't flag, and switching to it would regress the deliberate out-of-order
// deferred streaming - a real feature traded for a cosmetic exit code, so it is NOT done. The
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
    // Rejection is data, not a stream error - and REDACTED: the opaque code, never the raw reason
    // ("upstream failed" is logged server-side, not leaked to the client).
    expect(byId.get(1)).toEqual({ i: 1, e: "deferred_error" })
    expect(JSON.stringify(lines)).not.toContain("upstream failed")
  })
})

test("ndjsonStream: a value settling after the client cancelled writes nothing and logs nothing", async () => {
  const late = Promise.withResolvers<string>()
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    const reader = ndjsonStream({ now: 1 }, [{ id: 0, promise: late.promise }]).getReader()
    await reader.read()
    await reader.cancel("client went away")
    late.resolve("value")
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
    expect(errors).not.toHaveBeenCalled()
  } finally {
    errors.mockRestore()
  }
})

test("ndjsonStream: a value giving up on the request's abort is not logged, a real failure still is", async () => {
  const request = new AbortController()
  request.abort()
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    const gaveUp = new Promise((_, reject) => setTimeout(() => reject(request.signal.reason), 1))
    const lines = await readLines(
      ndjsonStream(
        {},
        [
          { id: 0, promise: gaveUp },
          { id: 1, promise: rejection("upstream failed") },
        ],
        undefined,
        request.signal,
      ),
    )
    expect(lines).toHaveLength(3)
    expect(errors).toHaveBeenCalledTimes(1)
    expect(String(errors.mock.calls[0]?.[1])).toContain("upstream failed")
  } finally {
    errors.mockRestore()
  }
})

test("ndjsonStream: a throwing error log still streams the opaque code and reaches the console", async () => {
  const errors = spyOn(console, "error").mockImplementation(() => {})
  try {
    const lines = await readLines(
      ndjsonStream(
        {},
        [{ id: 0, promise: rejection("upstream failed") }],
        undefined,
        undefined,
        () => {
          throw new Error("logger down")
        },
      ),
    )
    expect(lines.map((l) => JSON.parse(l))).toEqual([{}, { i: 0, e: "deferred_error" }])
    expect(String(errors.mock.calls[0]?.[1])).toContain("upstream failed")
  } finally {
    errors.mockRestore()
  }
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

  test("a malformed line cancels the body and releases it, on line 1 or later", async () => {
    const source = (lines: readonly string[]) => {
      const state = { cancelled: false }
      const enc = new TextEncoder()
      let next = 0
      // Pulled one line at a time and never closed: only a cancel ends it.
      const stream = new ReadableStream<Uint8Array>({
        pull(c) {
          const line = lines[next++]
          if (line !== undefined) c.enqueue(enc.encode(line))
        },
        // A source whose cancel fails is still released, with no unhandled rejection.
        cancel() {
          state.cancelled = true
          throw new Error("source already gone")
        },
      })
      return { stream, cancelled: () => state.cancelled }
    }
    const bad = source(["{not json\n"])
    await expect(parseNdjsonData(bad.stream)).rejects.toThrow()
    expect(bad.cancelled()).toBe(true)
    expect(bad.stream.locked).toBe(false)

    const later = source(['{"feed":{"__nifra_deferred":0}}\n', "{not json\n"])
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: line 1 of this body is the object `{ feed }`.
    const data = (await parseNdjsonData(later.stream)) as Record<string, unknown>
    await expect(asMarker(data.feed).promise).rejects.toThrow(/ended before/)
    expect(later.cancelled()).toBe(true)
    expect(later.stream.locked).toBe(false)
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

  // A `__proto__` key in the payload must land as ordinary own data, not walk the prototype setter -
  // and the rebuilt object must still be a *normal* object, since the app's components and whatever
  // helper library they use will call `Object.prototype` methods on it.
  test("a __proto__ key in the payload pollutes nothing, and the result keeps its prototype", async () => {
    const data = (await parseNdjsonData(
      streamOf([{ text: '{"user":{"__proto__":{"admin":true},"name":"ada"}}\n' }]),
    )) as { user: Record<string, unknown> }

    expect(({} as Record<string, unknown>).admin).toBeUndefined() // Object.prototype untouched
    expect(Object.getPrototypeOf(data.user)).toBe(Object.prototype)
    expect(Object.getOwnPropertyDescriptor(data.user, "__proto__")?.value).toEqual({ admin: true })
    expect(data.user.name).toBe("ada")
    expect(Object.hasOwn(data.user, "name")).toBe(true)
    expect(typeof data.user.toString).toBe("function") // usable by a template / helper library
  })

  test("an aborted stream leaves markers pending (a superseded nav - no error flash)", async () => {
    const ac = new AbortController()
    const data = (await parseNdjsonData(
      streamOf([
        { text: '{"feed":{"__nifra_deferred":0}}\n' },
        { text: '{"i":0,"v":"too late"}\n', delay: 200 },
      ]),
      ac.signal,
    )) as Record<string, unknown>
    ac.abort() // a newer navigation abandons this stream - markers detach, not error
    const outcome = await Promise.race([
      asMarker(data.feed).promise.then(
        () => "settled",
        () => "rejected",
      ),
      new Promise<string>((r) => setTimeout(() => r("pending"), 60)),
    ])
    expect(outcome).toBe("pending") // neither settled nor rejected (detached + GC'd, no flash)
  })

  test("an abort that has already errored the body leaves no unhandled rejection", async () => {
    // WebKit errors a fetch body when its signal aborts, before the parser's own abort listener
    // runs; cancelling an errored stream rejects.
    const ac = new AbortController()
    const enc = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('{"feed":{"__nifra_deferred":0}}\n'))
        ac.signal.addEventListener("abort", () =>
          c.error(new DOMException("Fetch is aborted", "AbortError")),
        )
      },
    })
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", onUnhandled)
    try {
      await parseNdjsonData(body, ac.signal)
      ac.abort()
      await new Promise((r) => setTimeout(r, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  test("duplicate placeholder ids in line 1 alias one promise - neither marker leaks", async () => {
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

  test("removes its abort listener once the stream completes - no listener accumulation", async () => {
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
