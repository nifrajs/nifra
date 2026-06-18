import { describe, expect, test } from "bun:test"
import {
  formatTraceparent,
  generateSpanId,
  generateTraceId,
  parseTraceparent,
} from "../src/index.ts"

describe("parseTraceparent", () => {
  test("parses a valid sampled header", () => {
    const p = parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
    expect(p).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      sampled: true,
    })
  })

  test("unsampled flag", () => {
    expect(
      parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00")?.sampled,
    ).toBe(false)
  })

  test("rejects malformed / absent / wrong-version / all-zero ids → null (fresh trace)", () => {
    expect(parseTraceparent(null)).toBeNull()
    expect(parseTraceparent("")).toBeNull()
    expect(parseTraceparent("garbage")).toBeNull()
    expect(parseTraceparent("00-tooshort-00f067aa0ba902b7-01")).toBeNull()
    expect(parseTraceparent("99-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBeNull() // version
    expect(parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01")).toBeNull() // zero trace
    expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01")).toBeNull() // zero span
    expect(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-XY")).toBeNull() // non-hex flags
    expect(parseTraceparent("00-4bf-00f067aa0ba902b7")).toBeNull() // 3 parts
  })
})

describe("formatTraceparent + ids", () => {
  test("round-trips through parse", () => {
    const tid = generateTraceId()
    const sid = generateSpanId()
    const header = formatTraceparent(tid, sid, true)
    expect(header).toBe(`00-${tid}-${sid}-01`)
    expect(parseTraceparent(header)).toEqual({ traceId: tid, spanId: sid, sampled: true })
  })

  test("ids are correct-length lowercase hex and unique", () => {
    const t1 = generateTraceId()
    const t2 = generateTraceId()
    expect(t1).toMatch(/^[0-9a-f]{32}$/)
    expect(generateSpanId()).toMatch(/^[0-9a-f]{16}$/)
    expect(t1).not.toBe(t2)
  })
})
