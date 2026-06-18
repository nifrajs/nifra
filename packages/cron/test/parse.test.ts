import { describe, expect, test } from "bun:test"
import { CronError, matches, nextRun, parseCron } from "../src/index.ts"

// Local-time dates (cron is local-time). Months are 0-based in the Date constructor.
const at = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo - 1, d, h, mi)

describe("parseCron — fields", () => {
  test("every minute", () => {
    const f = parseCron("* * * * *")
    expect(matches(f, at(2026, 6, 13, 3, 7))).toBe(true)
  })

  test("specific minute + hour", () => {
    const f = parseCron("30 14 * * *")
    expect(matches(f, at(2026, 6, 13, 14, 30))).toBe(true)
    expect(matches(f, at(2026, 6, 13, 14, 31))).toBe(false)
    expect(matches(f, at(2026, 6, 13, 13, 30))).toBe(false)
  })

  test("step */5 on minutes", () => {
    const f = parseCron("*/5 * * * *")
    expect(matches(f, at(2026, 6, 13, 0, 0))).toBe(true)
    expect(matches(f, at(2026, 6, 13, 0, 5))).toBe(true)
    expect(matches(f, at(2026, 6, 13, 0, 7))).toBe(false)
  })

  test("range + list", () => {
    const f = parseCron("0 9-17 * * 1,3,5") // top of the hour, 9am–5pm, Mon/Wed/Fri
    expect(matches(f, at(2026, 6, 8, 9, 0))).toBe(true) // 2026-06-08 is a Monday
    expect(matches(f, at(2026, 6, 8, 18, 0))).toBe(false) // 6pm out of range
    expect(matches(f, at(2026, 6, 9, 9, 0))).toBe(false) // Tuesday not in dow list
  })

  test("range with step a-b/n", () => {
    const f = parseCron("0-30/10 * * * *") // 0,10,20,30
    for (const m of [0, 10, 20, 30]) expect(matches(f, at(2026, 6, 13, 1, m))).toBe(true)
    expect(matches(f, at(2026, 6, 13, 1, 15))).toBe(false)
  })

  test("macros", () => {
    expect(matches(parseCron("@hourly"), at(2026, 6, 13, 5, 0))).toBe(true)
    expect(matches(parseCron("@hourly"), at(2026, 6, 13, 5, 1))).toBe(false)
    expect(matches(parseCron("@daily"), at(2026, 6, 13, 0, 0))).toBe(true)
    expect(matches(parseCron("@weekly"), at(2026, 6, 14, 0, 0))).toBe(true) // 2026-06-14 is a Sunday
  })

  test("dom/dow OR rule when both restricted", () => {
    const f = parseCron("0 0 1 * 1") // midnight on the 1st OR any Monday
    expect(matches(f, at(2026, 6, 1, 0, 0))).toBe(true) // the 1st (a Monday too)
    expect(matches(f, at(2026, 6, 8, 0, 0))).toBe(true) // a Monday, not the 1st
    expect(matches(f, at(2026, 6, 3, 0, 0))).toBe(false) // neither
  })

  test("rejects malformed expressions", () => {
    expect(() => parseCron("* * *")).toThrow(CronError) // too few fields
    expect(() => parseCron("60 * * * *")).toThrow(/out-of-range/) // minute 60
    expect(() => parseCron("* 24 * * *")).toThrow(/out-of-range/) // hour 24
    expect(() => parseCron("*/0 * * * *")).toThrow(/invalid step/)
    expect(() => parseCron("5-2 * * * *")).toThrow(/out-of-range/) // reversed range
  })
})

describe("nextRun", () => {
  test("next matching minute, never the current one", () => {
    const f = parseCron("*/15 * * * *")
    const next = nextRun(f, at(2026, 6, 13, 10, 7))
    expect(next).toEqual(at(2026, 6, 13, 10, 15))
  })

  test("rolls to the next hour/day", () => {
    const f = parseCron("0 0 * * *") // midnight
    const next = nextRun(f, at(2026, 6, 13, 23, 59))
    expect(next).toEqual(at(2026, 6, 14, 0, 0))
  })

  test("exactly on a match returns the NEXT occurrence (current minute excluded)", () => {
    const f = parseCron("0 * * * *")
    const next = nextRun(f, at(2026, 6, 13, 10, 0))
    expect(next).toEqual(at(2026, 6, 13, 11, 0))
  })
})
