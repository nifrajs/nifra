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

  test("rejects an invalid maxInFlight", () => {
    expect(() => createAdmissionController({ maxInFlight: 0 })).toThrow(/positive integer/)
  })

  test("event-loop lag sampler returns a finite non-negative number", () => {
    const sample = createEventLoopLagSampler(20)
    expect(sample()).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(sample())).toBe(true)
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
})
