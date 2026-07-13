import { describe, expect, test } from "bun:test"
import { NIFRA_DEADLINE_HEADER } from "@nifrajs/budget"
import { server } from "../src/index.ts"

const deadlineRequest = (deadline: string): Request =>
  new Request("http://test/budget", { headers: { [NIFRA_DEADLINE_HEADER]: deadline } })

describe("request deadline admission", () => {
  test("c.budget shares c.signal and exposes the local absolute deadline", async () => {
    let sameSignal = false
    let remaining = 0
    let deadline = 0
    const before = Date.now()
    const app = server({ requestTimeoutMs: 200 }).get("/budget", (c) => {
      sameSignal = c.budget.signal === c.signal
      remaining = c.budget.remaining()
      deadline = c.budget.deadline
      return { ok: true }
    })
    expect((await app.fetch(new Request("http://test/budget"))).status).toBe(200)
    expect(sameSignal).toBe(true)
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThanOrEqual(200)
    expect(deadline).toBeGreaterThanOrEqual(before + 150)
    expect(deadline).toBeLessThanOrEqual(Date.now() + 200)
  })

  test("no configured or inbound deadline preserves the unbounded path", async () => {
    let remaining = 0
    const app = server().get("/budget", (c) => {
      remaining = c.budget.remaining()
      return "ok"
    })
    expect((await app.fetch(new Request("http://test/budget"))).status).toBe(200)
    expect(remaining).toBe(Number.POSITIVE_INFINITY)
  })

  test("ignores an inbound deadline unless the trust boundary explicitly opts in", async () => {
    let calls = 0
    let remaining = 0
    const app = server().get("/budget", (c) => {
      calls++
      remaining = c.budget.remaining()
      return "ok"
    })
    const response = await app.fetch(deadlineRequest("hostile-or-untrusted"))
    expect(response.status).toBe(200)
    expect(calls).toBe(1)
    expect(remaining).toBe(Number.POSITIVE_INFINITY)
  })

  test("malformed and already-expired wire deadlines fail before the handler", async () => {
    let calls = 0
    const app = server({ acceptInboundDeadlines: true }).get("/budget", () => {
      calls++
      return "unreachable"
    })
    const malformed = await app.fetch(deadlineRequest("tomorrow"))
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ ok: false, error: "malformed_deadline" })
    const expired = await app.fetch(deadlineRequest(String(Date.now() - 1)))
    expect(expired.status).toBe(408)
    expect(await expired.json()).toEqual({ ok: false, error: "deadline_exceeded" })
    expect(calls).toBe(0)
  })

  test("a hostile far-future deadline is clamped by the local inbound cap", async () => {
    let observed = Number.POSITIVE_INFINITY
    let signal: AbortSignal | undefined
    const app = server({ acceptInboundDeadlines: true, maxInboundDeadlineMs: 20 }).get(
      "/budget",
      async (c) => {
        observed = c.budget.remaining()
        signal = c.signal
        await new Promise((resolve) => setTimeout(resolve, 80))
        return "late"
      },
    )
    const response = await app.fetch(deadlineRequest(String(Date.now() + 3_600_000)))
    expect(observed).toBeLessThanOrEqual(20)
    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({ ok: false, error: "deadline_exceeded" })
    expect(signal?.aborted).toBe(true)
  })

  test("requestTimeoutMs remains the tighter cap when a client asks for longer", async () => {
    let observed = Number.POSITIVE_INFINITY
    const app = server({
      requestTimeoutMs: 15,
      acceptInboundDeadlines: true,
      maxInboundDeadlineMs: 500,
    }).get("/budget", async (c) => {
      observed = c.budget.remaining()
      await new Promise((resolve) => setTimeout(resolve, 60))
      return "late"
    })
    const response = await app.fetch(deadlineRequest(String(Date.now() + 10_000)))
    expect(observed).toBeLessThanOrEqual(15)
    expect(response.status).toBe(504)
  })

  test("invalid local deadline policy is rejected at boot", () => {
    expect(() => server({ requestTimeoutMs: -1 })).toThrow(/requestTimeoutMs/)
    expect(() => server({ maxInboundDeadlineMs: 0 })).toThrow(/maxInboundDeadlineMs/)
  })
})
