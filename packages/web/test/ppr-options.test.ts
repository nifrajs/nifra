import { describe, expect, test } from "bun:test"
import {
  HTML_LIMITED_BOTS,
  PPR_DEFAULTS,
  resolvePprOptions,
  totalDeadlineMs,
  wantsBlockingRender,
} from "../src/internal/ppr/options.ts"

const withAgent = (agent: string | undefined): Request =>
  new Request(
    "https://example.test/p/1",
    agent === undefined ? {} : { headers: { "user-agent": agent } },
  )

describe("PPR options", () => {
  test("defaults match the plan's signed-off numbers", () => {
    expect(PPR_DEFAULTS).toEqual({
      holeTimeoutMs: 5000,
      maxHoleTimeoutMs: 30000,
      totalDeadlineSlackMs: 1000,
      maxHolesPerRoute: 32,
      shellEntriesPerRoute: 10000,
      shellStoreBytes: 64 * 1024 * 1024,
      notFoundTtlSeconds: 60,
      shellBuildConcurrency: 4,
      staleOnErrorFactor: 10,
      maxStaleOnErrorSeconds: 86400,
      blockingFor: HTML_LIMITED_BOTS,
      boundaryAbandonedTrip: 64,
      processAbandonedTrip: 1024,
      admissionStop: 4096,
      abandonGraceMs: 100,
      maxHoleWork: 1024,
      writeGraceMs: 5000,
      maxUnsentBytesPerResponse: 1024 * 1024,
      maxUnsentBytes: 256 * 1024 * 1024,
      frameBytes: 256 * 1024,
      minShellBytes: 1024,
    })
    expect(Object.isFrozen(PPR_DEFAULTS)).toBe(true)
  })

  test("an override replaces only its own key and the result is frozen", () => {
    const resolved = resolvePprOptions({ maxHoleWork: 4, holeTimeoutMs: 250 })
    expect(resolved.maxHoleWork).toBe(4)
    expect(resolved.holeTimeoutMs).toBe(250)
    expect(resolved.admissionStop).toBe(4096)
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(resolvePprOptions()).toEqual(PPR_DEFAULTS)
  })

  test("an undefined override keeps the default", () => {
    expect(resolvePprOptions({ maxHoleWork: undefined }).maxHoleWork).toBe(1024)
  })

  test("rejects unknown keys, non-integers, negatives and zero where a limit needs one", () => {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a misspelt key on purpose; the runtime refusal is what this checks.
    expect(() => resolvePprOptions({ maxHoleWrk: 4 } as never)).toThrow(
      'unknown option "maxHoleWrk"',
    )
    expect(() => resolvePprOptions({ holeTimeoutMs: 1.5 })).toThrow(
      "holeTimeoutMs must be a non-negative integer",
    )
    expect(() => resolvePprOptions({ writeGraceMs: -1 })).toThrow(
      "writeGraceMs must be a non-negative integer",
    )
    expect(() => resolvePprOptions({ maxHoleWork: Number.NaN })).toThrow(
      "maxHoleWork must be a non-negative integer",
    )
    expect(() => resolvePprOptions({ maxHoleWork: 0 })).toThrow("maxHoleWork must be at least 1")
    expect(resolvePprOptions({ writeGraceMs: 0 }).writeGraceMs).toBe(0)
  })

  test("rejects limits that contradict each other", () => {
    expect(() => resolvePprOptions({ holeTimeoutMs: 40000 })).toThrow(
      "holeTimeoutMs (40000) must not exceed maxHoleTimeoutMs (30000)",
    )
    expect(() => resolvePprOptions({ boundaryAbandonedTrip: 2000 })).toThrow(
      "boundaryAbandonedTrip (2000) must not exceed processAbandonedTrip (1024)",
    )
    expect(() => resolvePprOptions({ processAbandonedTrip: 5000 })).toThrow(
      "processAbandonedTrip (5000) must not exceed admissionStop (4096)",
    )
    expect(() => resolvePprOptions({ frameBytes: 2 * 1024 * 1024 })).toThrow(
      "must not exceed maxUnsentBytesPerResponse",
    )
    expect(() => resolvePprOptions({ maxUnsentBytes: 1024 })).toThrow(
      "maxUnsentBytesPerResponse (1048576) must not exceed maxUnsentBytes (1024)",
    )
  })

  test("blockingFor takes a pattern or a predicate, never a stateful pattern", () => {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a string on purpose; the runtime refusal is what this checks.
    expect(() => resolvePprOptions({ blockingFor: "bot" as never })).toThrow(
      "blockingFor must be a RegExp",
    )
    expect(() => resolvePprOptions({ blockingFor: /bot/g })).toThrow("must not use the g or y flag")
    expect(() => resolvePprOptions({ blockingFor: /bot/y })).toThrow("must not use the g or y flag")
    const byHeader = resolvePprOptions({ blockingFor: (r) => r.headers.has("x-render-blocking") })
    expect(wantsBlockingRender(byHeader, withAgent("Twitterbot/1.0"))).toBe(false)
    expect(
      wantsBlockingRender(
        byHeader,
        new Request("https://example.test/", { headers: { "x-render-blocking": "1" } }),
      ),
    ).toBe(true)
  })

  test("the default list matches HTML-limited bots and leaves browsers and Googlebot streamed", () => {
    const options = resolvePprOptions()
    for (const agent of [
      "Mozilla/5.0 (compatible; Twitterbot/1.0)",
      "facebookexternalhit/1.1",
      "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
      "Slackbot-LinkExpanding 1.0",
      "AdsBot-Google (+http://www.google.com/adsbot.html)",
      "Mozilla/5.0 Chrome-Lighthouse",
    ]) {
      expect(wantsBlockingRender(options, withAgent(agent))).toBe(true)
    }
    for (const agent of [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    ]) {
      expect(wantsBlockingRender(options, withAgent(agent))).toBe(false)
    }
    expect(wantsBlockingRender(options, withAgent(undefined))).toBe(false)
  })

  test("total deadline is the largest hole timeout plus slack, capped", () => {
    const options = resolvePprOptions()
    expect(totalDeadlineMs(options, [3000, 5000])).toBe(6000)
    expect(totalDeadlineMs(options, [30000])).toBe(30000)
    expect(totalDeadlineMs(options, [])).toBe(1000)
  })
})
