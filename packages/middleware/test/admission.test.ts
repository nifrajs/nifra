import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import {
  type AdmissionOptions,
  createAdmissionController,
  createEventLoopLagSampler,
} from "../src/index.ts"

const req = (path = "/") => new Request(`http://x${path}`)

function controller(options: Partial<AdmissionOptions> & { maxInFlight: number }) {
  return createAdmissionController(options)
}

describe("createAdmissionController — mechanics", () => {
  test("fast path admits under limit without touching the slow path", async () => {
    const c = controller({ maxInFlight: 4 })
    const a1 = await c.admit(req())
    const a2 = await c.admit(req())
    expect(a1.admitted && a2.admitted).toBe(true)
    expect(c.snapshot().inFlight).toBe(2)
    expect(c.snapshot().slowPathEntries).toBe(0)
    expect(c.snapshot().fastPathAdmits).toBe(2)
    if (a1.admitted) a1.release()
    expect(c.snapshot().inFlight).toBe(1)
  })

  test("release is idempotent", async () => {
    const c = controller({ maxInFlight: 2 })
    const a = await c.admit(req())
    if (a.admitted) {
      a.release()
      a.release()
    }
    expect(c.snapshot().inFlight).toBe(0)
  })

  test("saturation sheds with 429 + Retry-After + reason header", async () => {
    const c = controller({ maxInFlight: 2, maxQueue: 0 })
    const results = await Promise.all([
      c.admit(req()),
      c.admit(req()),
      c.admit(req()),
      c.admit(req()),
    ])
    const admitted = results.filter((r) => r.admitted)
    const shed = results.filter((r) => !r.admitted)
    expect(admitted).toHaveLength(2)
    expect(shed).toHaveLength(2)
    for (const s of shed) {
      if (!s.admitted) {
        expect(s.response.status).toBe(429)
        expect(Number(s.response.headers.get("retry-after"))).toBeGreaterThanOrEqual(1)
        expect(s.response.headers.get("x-nifra-shed-reason")).toBe("inflight")
      }
    }
  })

  test("queue then admit: a released slot is handed to a waiter, conserving inFlight", async () => {
    const c = controller({ maxInFlight: 1, maxQueue: 1, queueTimeoutMs: 1000 })
    const first = await c.admit(req())
    const secondP = c.admit(req()) // queues
    expect(c.snapshot().queued).toBe(1)
    if (first.admitted) first.release()
    const second = await secondP
    expect(second.admitted).toBe(true)
    expect(c.snapshot().inFlight).toBe(1)
    expect(c.snapshot().queued).toBe(0)
  })

  test("queue timeout sheds with reason queue-timeout", async () => {
    const c = controller({ maxInFlight: 1, maxQueue: 1, queueTimeoutMs: 5 })
    const first = await c.admit(req()) // holds the only slot
    const second = await c.admit(req()) // queues, then times out
    expect(first.admitted).toBe(true)
    expect(second.admitted).toBe(false)
    if (!second.admitted)
      expect(second.response.headers.get("x-nifra-shed-reason")).toBe("queue-timeout")
  })

  test("an aborted queued request is removed immediately without consuming a future slot", async () => {
    const c = controller({ maxInFlight: 1, maxQueue: 1, queueTimeoutMs: 10_000 })
    const first = await c.admit(req())
    const aborted = new AbortController()
    const queued = c.admit(new Request("http://x/", { signal: aborted.signal }))
    expect(c.snapshot().queued).toBe(1)
    aborted.abort()
    const cancelled = await queued
    expect(cancelled.admitted).toBe(false)
    if (!cancelled.admitted) {
      expect(cancelled.response.status).toBe(499)
      expect(cancelled.response.headers.get("x-nifra-shed-reason")).toBe("cancelled")
    }
    expect(c.snapshot().queued).toBe(0)
    if (first.admitted) first.release()
    expect(c.snapshot().inFlight).toBe(0)
  })

  test("loop-lag sheds even with free slots", async () => {
    let lag = 0
    const c = controller({ maxInFlight: 10, maxLagMs: 50, lagMs: () => lag })
    const healthy = await c.admit(req())
    lag = 250
    const laggy = await c.admit(req())
    expect(healthy.admitted).toBe(true)
    expect(laggy.admitted).toBe(false)
    if (!laggy.admitted) expect(laggy.response.headers.get("x-nifra-shed-reason")).toBe("loop-lag")
  })

  test("private policy: reserved headroom admits a priority request where a normal one sheds", async () => {
    const c = createAdmissionController({
      maxInFlight: 1,
      maxQueue: 0,
      reservedForPolicy: 1,
      policy: (r) => (r.headers.get("x-tier") === "priority" ? { decision: "admit" } : undefined),
    })
    const hog = await c.admit(new Request("http://x/", { headers: { "x-tier": "free" } }))
    const freeShed = await c.admit(new Request("http://x/", { headers: { "x-tier": "free" } }))
    const vip = await c.admit(new Request("http://x/", { headers: { "x-tier": "priority" } }))
    expect(hog.admitted).toBe(true)
    expect(freeShed.admitted).toBe(false)
    expect(vip.admitted).toBe(true)
    expect(c.snapshot().inFlight).toBe(2)
  })

  test("reserved policy headroom is never transferred to an ordinary queued request", async () => {
    const c = createAdmissionController({
      maxInFlight: 1,
      maxQueue: 1,
      queueTimeoutMs: 1000,
      reservedForPolicy: 1,
      policy: (r) => (r.headers.get("x-tier") === "priority" ? { decision: "admit" } : undefined),
    })
    const ordinary = await c.admit(req())
    const queued = c.admit(req())
    const priority = await c.admit(new Request("http://x/", { headers: { "x-tier": "priority" } }))
    expect(c.snapshot()).toMatchObject({ inFlight: 2, queued: 1 })

    if (priority.admitted) priority.release()
    await Promise.resolve()
    // The reserved slot disappeared; it did not leak to the normal FIFO.
    expect(c.snapshot()).toMatchObject({ inFlight: 1, queued: 1 })

    if (ordinary.admitted) ordinary.release()
    const admitted = await queued
    expect(admitted.admitted).toBe(true)
    expect(c.snapshot()).toMatchObject({ inFlight: 1, queued: 0 })
    if (admitted.admitted) admitted.release()
  })

  test("policy Retry-After is an override, not an addition to the base delay", async () => {
    const c = createAdmissionController({
      maxInFlight: 1,
      baseRetryAfterSec: 5,
      policy: () => ({ decision: "shed", retryAfterSec: 2 }),
    })
    const result = await c.admit(req())
    expect(result.admitted).toBe(false)
    if (!result.admitted) expect(result.response.headers.get("retry-after")).toBe("2")
  })

  test("invalid custom capacity evidence fails closed with a valid Retry-After", async () => {
    const badLag = createAdmissionController({
      maxInFlight: 2,
      maxLagMs: 10,
      lagMs: () => Number.NaN,
    })
    const lagged = await badLag.admit(req())
    expect(lagged.admitted).toBe(false)
    if (!lagged.admitted) {
      expect(lagged.response.headers.get("x-nifra-shed-reason")).toBe("loop-lag")
    }
    const badPolicy = createAdmissionController({
      maxInFlight: 2,
      baseRetryAfterSec: 3,
      policy: () => ({ decision: "shed", retryAfterSec: Number.NaN }),
    })
    const shed = await badPolicy.admit(req())
    expect(shed.admitted).toBe(false)
    if (!shed.admitted) expect(shed.response.headers.get("retry-after")).toBe("3")
  })

  test("rejects an invalid maxInFlight", () => {
    expect(() => createAdmissionController({ maxInFlight: 0 })).toThrow(/positive integer/)
  })

  test("rejects non-finite or negative admission policy knobs", () => {
    expect(() => createAdmissionController({ maxInFlight: 1, maxLagMs: Number.NaN })).toThrow(
      /maxLagMs/,
    )
    expect(() => createAdmissionController({ maxInFlight: 1, queueTimeoutMs: -1 })).toThrow(
      /queueTimeoutMs/,
    )
    expect(() => createAdmissionController({ maxInFlight: 1, reservedForPolicy: -1 })).toThrow(
      /reservedForPolicy/,
    )
    expect(() => createAdmissionController({ maxInFlight: 1, baseRetryAfterSec: 0 })).toThrow(
      /baseRetryAfterSec/,
    )
    expect(() => createEventLoopLagSampler(0)).toThrow(/resolutionMs/)
  })

  test("event-loop lag sampler returns a finite non-negative number", () => {
    const sample = createEventLoopLagSampler(20)
    expect(sample()).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(sample())).toBe(true)
  })

  test("lag sampler samples an injected histogram (mean converted ns→ms, baseline subtracted)", () => {
    let mean = 25_000_000 // 25ms in ns
    const sample = createEventLoopLagSampler(20, () => ({
      enable() {},
      reset() {},
      get mean() {
        return mean
      },
    }))
    expect(sample()).toBeCloseTo(5, 5) // 25ms mean - 20ms resolution baseline
    mean = Number.NaN
    expect(sample()).toBe(0) // non-finite mean -> 0
  })

  test("lag sampler falls back to 0 when the runtime exposes no histogram", () => {
    const sample = createEventLoopLagSampler(20, () => undefined)
    expect(sample()).toBe(0)
  })

  test("lag sampler falls back to 0 when the monitor throws", () => {
    const sample = createEventLoopLagSampler(20, () => {
      throw new Error("no perf_hooks here")
    })
    expect(sample()).toBe(0)
  })
})

describe("server({ admission }) — request-path integration", () => {
  test("admits under capacity and serves the route (native matching intact)", async () => {
    const app = server({ admission: controller({ maxInFlight: 4 }) }).get("/hi", () => "ok")
    const res = await app.fetch(req("/hi"))
    expect(res.status).toBe(200)
    expect(await res.json()).toBe("ok")
  })

  test("sheds concurrent work beyond capacity, then recovers once slots free", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const app = server({ admission: controller({ maxInFlight: 1, maxQueue: 0 }) }).get(
      "/slow",
      async () => {
        await gate // hold the single slot open
        return "done"
      },
    )

    const inflight = app.fetch(req("/slow")) // occupies the only slot
    await Promise.resolve()
    const shed = await app.fetch(req("/slow")) // no slot -> shed
    expect(shed.status).toBe(429)
    expect(shed.headers.get("retry-after")).not.toBeNull()

    release()
    expect((await inflight).status).toBe(200)

    // slot released -> a fresh request is admitted again
    const after = await app.fetch(req("/slow"))
    // (gate already resolved, so this one completes immediately)
    expect(after.status).toBe(200)
  })

  test("releases the slot even when the handler throws", async () => {
    const c = controller({ maxInFlight: 1, maxQueue: 0 })
    const app = server({ admission: c })
      .get("/boom", () => {
        throw new Error("kaboom")
      })
      .get("/ok", () => "ok")
    const boom = await app.fetch(req("/boom"))
    expect(boom.status).toBe(500)
    expect(c.snapshot().inFlight).toBe(0) // slot released despite the throw
    const ok = await app.fetch(req("/ok"))
    expect(ok.status).toBe(200)
  })

  test("gates the context path too (an onRequest hook forces the non-native pipeline)", async () => {
    const c = controller({ maxInFlight: 5 })
    const app = server({ admission: c })
      .onRequest(() => undefined)
      .get("/ctx", () => "ok")
    const res = await app.fetch(req("/ctx"))
    expect(res.status).toBe(200)
    expect(c.snapshot().inFlight).toBe(0) // slot admitted + released through the context path
  })

  test("queued request (admit resolves asynchronously) is served once a slot frees", async () => {
    const c = controller({ maxInFlight: 1, maxQueue: 1 })
    let open: () => void = () => {}
    const gate = new Promise<void>((r) => {
      open = r
    })
    const app = server({ admission: c })
      .get("/slow", async () => {
        await gate // hold the only slot
        return "slow"
      })
      .get("/queued", () => "queued")
    const first = app.fetch(req("/slow")) // takes the slot
    await new Promise((r) => setTimeout(r, 0))
    const second = app.fetch(req("/queued")) // no slot → queues → admit returns a Promise (admitGated.then)
    await new Promise((r) => setTimeout(r, 0))
    open()
    const [r1, r2] = await Promise.all([first, second])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(c.snapshot().inFlight).toBe(0)
  })

  test("releases the slot when an async handler rejects", async () => {
    const c = controller({ maxInFlight: 1, maxQueue: 0 })
    const app = server({ admission: c })
      .get("/boom", async () => {
        throw new Error("async-kaboom")
      })
      .get("/ok", () => "ok")
    const boom = await app.fetch(req("/boom"))
    expect(boom.status).toBe(500)
    expect(c.snapshot().inFlight).toBe(0) // slot released on the async-rejection path too
    const ok = await app.fetch(req("/ok"))
    expect(ok.status).toBe(200)
  })
})
