import { describe, expect, test } from "bun:test"
import { toDeadLetterView, toQueueHealth } from "../src/dead-letter-view.ts"

describe("toDeadLetterView - content-free dead-letter projection", () => {
  test("projects identity plus a deterministic grouping key, never the error text", () => {
    const views = toDeadLetterView([
      { id: "job_1", name: "send-email", error: "smtp: connection refused" },
      { id: "job_2", name: "send-email", error: "smtp: connection refused" },
      { id: "job_3", name: "webhook", error: "timeout after 5000ms" },
    ])
    expect(views).toHaveLength(3)
    const first = views[0]
    const second = views[1]
    const third = views[2]
    if (first === undefined || second === undefined || third === undefined)
      throw new Error("expected three dead-letter views")
    expect(first).toEqual({
      id: "job_1",
      name: "send-email",
      errorFingerprint: first.errorFingerprint,
    })
    // Identical errors group; different errors do not.
    expect(first.errorFingerprint).toBe(second.errorFingerprint)
    expect(first.errorFingerprint).not.toBe(third.errorFingerprint)
    expect(first.errorFingerprint).toMatch(/^[0-9a-f]{8}$/)
    // The error text - which can carry payloads - never leaves the projection.
    expect(JSON.stringify(views)).not.toContain("smtp")
    expect(JSON.stringify(views)).not.toContain("timeout")
  })

  test("is deterministic across calls", () => {
    const record = { id: "job_1", name: "x", error: "boom" }
    expect(toDeadLetterView([record])[0]?.errorFingerprint).toBe(
      toDeadLetterView([record])[0]?.errorFingerprint,
    )
  })

  test("fails closed on malformed records", () => {
    expect(() => toDeadLetterView([{ id: "", name: "x", error: "e" }])).toThrow(/id/)
    expect(() => toDeadLetterView([{ id: "a", name: "", error: "e" }])).toThrow(/name/)
    expect(() =>
      toDeadLetterView([{ id: "a", name: "x", error: 42 as unknown as string }]),
    ).toThrow(/error/)
  })
  test("rejects sparse records and oversized identity/error fields", () => {
    const sparse: unknown[] = []
    sparse.length = 1
    expect(() => toDeadLetterView(sparse as never)).toThrow(/index 0/)
    expect(() => toDeadLetterView([{ id: "x".repeat(129), name: "x", error: "e" }])).toThrow(
      /id.*length/,
    )
    expect(() => toDeadLetterView([{ id: "x", name: "x".repeat(129), error: "e" }])).toThrow(
      /name.*length/,
    )
    expect(() => toDeadLetterView([{ id: "x", name: "x", error: "e".repeat(65 * 1024) }])).toThrow(
      /error.*length/,
    )
  })
})

describe("toQueueHealth - counter passthrough", () => {
  test("passes counters through frozen", () => {
    expect(toQueueHealth({ pending: 2, active: 1, dead: 3 })).toEqual({
      pending: 2,
      active: 1,
      dead: 3,
    })
  })

  test("rejects non-counters", () => {
    expect(() => toQueueHealth({ pending: -1, active: 0, dead: 0 })).toThrow(/pending/)
    expect(() => toQueueHealth({ pending: 0.5, active: 0, dead: 0 })).toThrow(/pending/)
  })
  test("rejects missing and unknown counter fields", () => {
    expect(() => toQueueHealth({ pending: 0, active: 0 } as never)).toThrow(/dead/)
    expect(() => toQueueHealth({ pending: 0, active: 0, dead: 0, extra: 1 } as never)).toThrow(
      /unknown counter/,
    )
  })
})
