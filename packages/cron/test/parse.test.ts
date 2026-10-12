import { describe, expect, test } from "bun:test"
import { CronError, matches, nextRun, parseCron } from "../src/index.ts"

// Local-time dates (cron is local-time). Months are 0-based in the Date constructor.
const at = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo - 1, d, h, mi)

describe("parseCron - fields", () => {
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
    const f = parseCron("0 9-17 * * 1,3,5") // top of the hour, 9am-5pm, Mon/Wed/Fri
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

  test("a day field led by a star-step is unrestricted, so both day fields must match", () => {
    const f = parseCron("0 0 */2 * 1") // midnight on an odd day that is also a Monday
    expect(f.domRestricted).toBe(false)
    expect(matches(f, at(2026, 6, 15, 0, 0))).toBe(true) // the 15th, a Monday
    expect(matches(f, at(2026, 6, 8, 0, 0))).toBe(false) // a Monday on an even day
    expect(matches(f, at(2026, 6, 3, 0, 0))).toBe(false) // an odd day, a Wednesday
    const g = parseCron("0 0 1 * */2") // the 1st, when it falls on Sun/Tue/Thu/Sat
    expect(g.dowRestricted).toBe(false)
    expect(matches(g, at(2026, 9, 1, 0, 0))).toBe(true) // 2026-09-01 is a Tuesday
    expect(matches(g, at(2026, 6, 1, 0, 0))).toBe(false) // 2026-06-01 is a Monday
    expect(matches(g, at(2026, 9, 3, 0, 0))).toBe(false) // a Thursday, not the 1st
    const odd = parseCron("0 0 */2 * *") // neither field restricted, the step still applies
    expect(matches(odd, at(2026, 6, 3, 0, 0))).toBe(true)
    expect(matches(odd, at(2026, 6, 8, 0, 0))).toBe(false)
  })

  test("day-of-week 7 is Sunday", () => {
    expect([...parseCron("0 0 * * 7").dow]).toEqual([0])
    expect([...parseCron("0 0 * * 5-7").dow].toSorted((a, b) => a - b)).toEqual([0, 5, 6])
    expect(matches(parseCron("0 0 * * 7"), at(2026, 6, 14, 0, 0))).toBe(true) // a Sunday
    // Stars and bare steps still stop at 6, so expressions that parsed before keep their days.
    expect([...parseCron("0 0 * * *").dow]).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect([...parseCron("0 0 * * 1/2").dow]).toEqual([1, 3, 5])
    expect([...parseCron("0 0 * * 7/2").dow]).toEqual([0])
    expect(() => parseCron("0 0 * * 8")).toThrow(/out-of-range/)
  })

  test("rejects malformed expressions", () => {
    expect(() => parseCron("* * *")).toThrow(CronError) // too few fields
    expect(() => parseCron("60 * * * *")).toThrow(/out-of-range/) // minute 60
    expect(() => parseCron("* 24 * * *")).toThrow(/out-of-range/) // hour 24
    expect(() => parseCron("*/0 * * * *")).toThrow(/invalid step/)
    expect(() => parseCron("5-2 * * * *")).toThrow(/out-of-range/) // reversed range
  })

  test("only plain decimal terms parse", () => {
    for (const term of ["-5", "5-", "1-2-3", "0x1F", "1e1", "+3", "*/5/7", "5.0"])
      expect(() => parseCron(`${term} * * * *`)).toThrow(/invalid term/)
  })

  test("a bare value with a step runs to the end of the field", () => {
    expect([...parseCron("5/15 * * * *").minute]).toEqual([5, 20, 35, 50])
    expect([...parseCron("0 20/2 * * *").hour]).toEqual([20, 22])
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
