import { describe, expect, test } from "bun:test"
import {
  admitDeadline,
  assertBudgetRemaining,
  type BudgetClock,
  canAttempt,
  createRequestBudget,
  createUnboundedRequestBudget,
  DeadlineExceededError,
  NIFRA_DEADLINE_HEADER,
  parseDeadlineHeader,
  withDeadlineHeader,
} from "../src/index.ts"

const clock = (
  wall = 1_700_000_000_000,
  monotonic = 100,
): BudgetClock & {
  wallMs: number
  monotonicMs: number
} => ({
  wallMs: wall,
  monotonicMs: monotonic,
  wall() {
    return this.wallMs
  },
  monotonic() {
    return this.monotonicMs
  },
})

describe("@nifrajs/budget", () => {
  test("measures admitted remaining time with the monotonic clock", () => {
    const c = clock()
    const budget = createRequestBudget({
      deadline: c.wallMs + 1_000,
      signal: new AbortController().signal,
      clock: c,
    })
    expect(budget.remaining()).toBe(1_000)
    c.monotonicMs += 125
    c.wallMs -= 60_000 // NTP jump backwards cannot add time.
    expect(budget.remaining()).toBe(875)
    c.wallMs += 120_000 // Nor can a forward wall jump consume it.
    expect(budget.remaining()).toBe(875)
  })

  test("child reserves finish earlier without mutating the parent", () => {
    const c = clock()
    const parent = createRequestBudget({
      deadline: c.wallMs + 1_000,
      signal: new AbortController().signal,
      clock: c,
    })
    const child = parent.child(150)
    expect(parent.remaining()).toBe(1_000)
    expect(child.remaining()).toBe(850)
    expect(child.deadline).toBe(parent.deadline - 150)
    expect(child.signal).toBe(parent.signal)
  })

  test("an aborted signal makes every view immediately exhausted", () => {
    const c = clock()
    const controller = new AbortController()
    const budget = createRequestBudget({
      deadline: c.wallMs + 1_000,
      signal: controller.signal,
      clock: c,
    })
    controller.abort()
    expect(budget.remaining()).toBe(0)
    expect(budget.child(10).remaining()).toBe(0)
  })

  test("parses one strict absolute deadline and rejects ambiguous input", () => {
    expect(parseDeadlineHeader(new Headers())).toEqual({ ok: false, reason: "missing" })
    expect(parseDeadlineHeader(new Headers({ [NIFRA_DEADLINE_HEADER]: "1700000001000" }))).toEqual({
      ok: true,
      deadline: 1_700_000_001_000,
    })
    for (const value of ["", "0", "-1", "1.5", "1e12", "1, 2", "NaN"]) {
      expect(parseDeadlineHeader(new Headers({ [NIFRA_DEADLINE_HEADER]: value }))).toEqual({
        ok: false,
        reason: "malformed",
      })
    }
  })

  test("propagates the absolute deadline with an optional reserve", () => {
    const c = clock()
    const budget = createRequestBudget({
      deadline: c.wallMs + 500,
      signal: new AbortController().signal,
      clock: c,
    })
    const headers = withDeadlineHeader({ authorization: "Bearer x" }, budget, 50)
    expect(headers.get("authorization")).toBe("Bearer x")
    expect(headers.get(NIFRA_DEADLINE_HEADER)).toBe(String(c.wallMs + 450))
  })

  test("admits and clamps a wire deadline to local policy", () => {
    const now = 1_700_000_000_000
    const far = new Headers({ [NIFRA_DEADLINE_HEADER]: String(now + 60_000) })
    expect(
      admitDeadline(far, {
        localTimeoutMs: 500,
        maxInboundDeadlineMs: 5_000,
        wallNow: () => now,
      }),
    ).toEqual({ ok: true, inherited: true, timeoutMs: 500, deadline: now + 500 })
    expect(admitDeadline(far, { maxInboundDeadlineMs: 2_000, wallNow: () => now })).toEqual({
      ok: true,
      inherited: true,
      timeoutMs: 2_000,
      deadline: now + 2_000,
    })
  })

  test("fails closed on malformed/expired deadlines and preserves an unbounded missing header", () => {
    const now = 1_700_000_000_000
    expect(admitDeadline(new Headers(), { wallNow: () => now })).toEqual({
      ok: true,
      inherited: false,
      timeoutMs: 0,
    })
    expect(
      admitDeadline(new Headers({ [NIFRA_DEADLINE_HEADER]: "bad" }), { wallNow: () => now }),
    ).toEqual({ ok: false, status: 400, reason: "malformed_deadline" })
    expect(
      admitDeadline(new Headers({ [NIFRA_DEADLINE_HEADER]: String(now) }), {
        wallNow: () => now,
      }),
    ).toEqual({ ok: false, status: 408, reason: "deadline_exceeded" })
  })

  test("does not sample wall time for an unbounded request without a deadline header", () => {
    let samples = 0
    expect(
      admitDeadline(new Headers(), {
        wallNow: () => {
          samples += 1
          return 1_700_000_000_000
        },
      }),
    ).toEqual({ ok: true, inherited: false, timeoutMs: 0 })
    expect(samples).toBe(0)
  })

  test("does not put an unbounded local sentinel on the wire", () => {
    const budget = createUnboundedRequestBudget(new AbortController().signal)
    expect(budget.remaining()).toBe(Number.POSITIVE_INFINITY)
    expect(withDeadlineHeader(undefined, budget).has(NIFRA_DEADLINE_HEADER)).toBe(false)
  })

  test("admits attempts only when their estimate and reserve fit", () => {
    const c = clock()
    const budget = createRequestBudget({
      deadline: c.wallMs + 100,
      signal: new AbortController().signal,
      clock: c,
    })
    expect(canAttempt(budget, 79, 20)).toBe(true)
    expect(canAttempt(budget, 80, 20)).toBe(false)
    expect(() => assertBudgetRemaining(budget, 99)).not.toThrow()
    expect(() => assertBudgetRemaining(budget, 100)).toThrow(DeadlineExceededError)
  })

  test("rejects unsafe configuration", () => {
    const signal = new AbortController().signal
    expect(() => createRequestBudget({ deadline: Number.MAX_VALUE, signal })).toThrow(
      /safe-integer/,
    )
    const c = clock()
    const budget = createRequestBudget({ deadline: c.wallMs + 1_000, signal, clock: c })
    expect(() => budget.child(-1)).toThrow(/reserveMs/)
    expect(() => canAttempt(budget, Number.NaN)).toThrow(/estimatedAttemptMs/)
  })
})
