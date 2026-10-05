import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { MetricType, ReportOpts } from "web-vitals"
import { reportWith, type VitalsLibrary } from "../src/internal/vitals-runtime.ts"
import { setBrowserNavigate } from "../src/navigation.ts"
import type { ClientRouter } from "../src/router.ts"
import { reportWebVitals, type WebVitalsMetric } from "../src/vitals.ts"

type Registration = {
  readonly name: string
  readonly report: (metric: MetricType) => void
  readonly options: ReportOpts | undefined
}

/** A stand-in for `web-vitals` that records each registration, so a test can report through it. */
function fakeLibrary(): { readonly library: VitalsLibrary; readonly registered: Registration[] } {
  const registered: Registration[] = []
  const on =
    (name: string) =>
    (report: (metric: MetricType) => void, options?: ReportOpts): void => {
      registered.push({ name, report, options })
    }
  return {
    registered,
    library: {
      onCLS: on("CLS"),
      onFCP: on("FCP"),
      onINP: on("INP"),
      onLCP: on("LCP"),
      onTTFB: on("TTFB"),
    },
  }
}

const metric = (name: MetricType["name"], navigationURL?: string): MetricType =>
  ({
    name,
    value: 120,
    rating: "good",
    delta: 120,
    id: `v6-${name}`,
    entries: [],
    navigationType: navigationURL === undefined ? "navigate" : "soft-navigation",
    navigationId: 1,
    ...(navigationURL === undefined ? {} : { navigationURL }),
  }) as MetricType

const router = {
  match: (path: string) =>
    path.startsWith("/users/") ? { routeId: "users/[id]", params: { id: path.slice(7) } } : null,
} as unknown as ClientRouter

const globals = globalThis as { document?: unknown; location?: unknown }

describe("reportWith", () => {
  beforeEach(() => {
    globals.document = {}
    globals.location = new URL("https://app.test/users/1")
    setBrowserNavigate(() => {}, router)
  })
  afterEach(() => {
    delete globals.document
    delete globals.location
    setBrowserNavigate(undefined)
  })

  test("registers with every metric and passes the options through", () => {
    const { library, registered } = fakeLibrary()
    reportWith(library, () => {}, {})
    reportWith(library, () => {}, { reportAllChanges: true, softNavigations: true })
    expect(registered.map((entry) => entry.name)).toEqual([
      "CLS",
      "FCP",
      "INP",
      "LCP",
      "TTFB",
      "CLS",
      "FCP",
      "INP",
      "LCP",
      "TTFB",
    ])
    expect(registered[0]?.options).toEqual({ reportAllChanges: false, reportSoftNavs: false })
    expect(registered[5]?.options).toEqual({ reportAllChanges: true, reportSoftNavs: true })
  })

  test("names the route of the URL each metric was measured on", () => {
    const { library, registered } = fakeLibrary()
    const seen: WebVitalsMetric[] = []
    reportWith(library, (reported) => seen.push(reported), {})
    const lcp = registered.find((entry) => entry.name === "LCP")
    const cls = registered.find((entry) => entry.name === "CLS")
    lcp?.report(metric("LCP", "https://app.test/users/42?tab=posts"))
    cls?.report(metric("CLS"))
    lcp?.report(metric("LCP", "https://app.test/about"))
    lcp?.report(metric("LCP", "https://elsewhere.test/users/42"))
    expect(seen.map((reported) => [reported.name, reported.route])).toEqual([
      ["LCP", "users/[id]"],
      ["CLS", "users/[id]"],
      ["LCP", undefined],
      ["LCP", undefined],
    ])
    expect(seen[0]).toMatchObject({ value: 120, rating: "good", id: "v6-LCP" })
  })

  test("reports no route before the router mounts", () => {
    setBrowserNavigate(undefined)
    const { library, registered } = fakeLibrary()
    const seen: WebVitalsMetric[] = []
    reportWith(library, (reported) => seen.push(reported), {})
    registered[0]?.report(metric("CLS", "https://app.test/users/1"))
    expect(seen[0]?.route).toBeUndefined()
  })

  test("each report is a copy, and stopping ends the reports", () => {
    const { library, registered } = fakeLibrary()
    const seen: WebVitalsMetric[] = []
    const stop = reportWith(library, (reported) => seen.push(reported), {})
    const live = metric("INP")
    registered[2]?.report(live)
    ;(live as { value: number }).value = 400
    expect(seen[0]?.value).toBe(120)
    stop()
    registered[2]?.report(live)
    expect(seen).toHaveLength(1)
  })
})

describe("reportWebVitals", () => {
  test("does nothing on the server", () => {
    const stop = reportWebVitals(() => {
      throw new Error("no metric is measured on the server")
    })
    expect(typeof stop).toBe("function")
    stop()
  })
})
