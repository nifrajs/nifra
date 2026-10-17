import { describe, expect, test } from "bun:test"
import {
  clientScriptUrls,
  measureHydrationPayload,
  median,
  pairedRatio,
  parseOha,
  roundOrder,
  rowKind,
  type SsrBenchTarget,
} from "./harness.ts"
import { frontendSlice, heroSsrSlice, multipliersSlice, ssrTablesSlice } from "./site-slice.ts"
import { staticFileFor } from "./static-path.ts"
import { ALL_TABLE_SECTIONS } from "./targets.ts"

const targets = ALL_TABLE_SECTIONS.flatMap((section) => section.targets)
const tables = (which: "A" | "B") =>
  ALL_TABLE_SECTIONS.filter((section) => section.label.includes(`Table ${which}`))
const nifraRows = (section: (typeof ALL_TABLE_SECTIONS)[number]) =>
  section.targets.filter((t) => t.name.startsWith("nifra+"))

describe("like-for-like rows", () => {
  test("every port is unique and every baseline is a row of its own table", () => {
    expect(new Set(targets.map((t) => t.port)).size).toBe(targets.length)
    for (const section of ALL_TABLE_SECTIONS) {
      expect(section.targets.map((t) => t.name)).toContain(section.baseline)
    }
  })

  test("Table A: a nifra app per runtime, built by `nifra build` and served by its server.js", () => {
    for (const section of tables("A")) {
      const apps = nifraRows(section).filter((t) => rowKind(t) === "app")
      expect(apps.map((t) => t.runtime).sort()).toEqual(["bun", "node"])
      for (const app of apps) {
        expect(app.build.slice(2, 5)).toEqual(["build", "--target", app.runtime])
        expect(app.serve).toEqual([app.runtime, `dist-${app.runtime}/server.js`])
        expect(app.warmupCache).toBeUndefined()
      }
    }
  })

  test("Table A: the own-server rows are labelled, one per runtime", () => {
    for (const section of tables("A")) {
      const own = section.targets.filter((t) => rowKind(t) === "own-server")
      expect(own.map((t) => t.runtime).sort()).toEqual(["bun", "node"])
      for (const t of own) expect(t.name).toContain("own server")
    }
  })

  test("Table B: SSG through the generated server on both runtimes, plus a static-host row", () => {
    for (const section of tables("B")) {
      const ssg = nifraRows(section).filter((t) => t.name.includes("SSG"))
      const served = ssg.filter((t) => rowKind(t) === "app")
      expect(served.map((t) => t.runtime).sort()).toEqual(["bun", "node"])
      for (const t of served) expect(t.serve).toEqual([t.runtime, `dist-${t.runtime}/server.js`])
      const host = ssg.filter((t) => rowKind(t) === "static-host")
      expect(host).toHaveLength(1)
      expect(host[0]?.build.slice(2, 5)).toEqual(["build", "--target", "static"])
    }
  })

  test("React ISR runs the same createWebApp entry on both runtimes, cache-warmed", () => {
    const react = tables("B").find((section) => section.label.startsWith("React"))
    const isr = react?.targets.filter((t) => t.name.startsWith("nifra+") && t.name.includes("ISR"))
    expect(isr?.map((t) => t.runtime).sort()).toEqual(["bun", "node"])
    for (const t of isr ?? []) {
      expect(t.warmupCache).toBe(true)
      expect(t.build).toEqual(isr?.[0]?.build ?? [])
    }
  })
})

describe("interleaved rounds", () => {
  test("each round is a rotation of every target, reversed on odd rounds", () => {
    const items = ["a", "b", "c", "d"]
    expect(roundOrder(items, 0)).toEqual(["a", "b", "c", "d"])
    expect(roundOrder(items, 1)).toEqual(["d", "c", "b", "a"])
    expect(roundOrder(items, 2)).toEqual(["b", "c", "d", "a"])
    for (let round = 0; round < 8; round++) {
      expect([...roundOrder(items, round)].sort()).toEqual(items)
    }
    expect(roundOrder([], 3)).toEqual([])
  })

  test("a paired ratio cancels load drift that moves both rows of a round", () => {
    const base = [1000, 500, 800, 250, 900]
    const row = base.map((rps) => rps * 1.25)
    expect(pairedRatio(row, base)).toBeCloseTo(1.25, 10)
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(pairedRatio([10], [0])).toBe(0)
  })
})

describe("successful SSR samples", () => {
  const sample = (successRate: number, statuses: Record<string, number>) =>
    JSON.stringify({
      summary: { requestsPerSec: 1000, successRate },
      latencyPercentiles: { p50: 0.001, p99: 0.005 },
      statusCodeDistribution: statuses,
    })

  test("accepts a fully successful HTTP 200 sample", () => {
    expect(parseOha(sample(1, { "200": 1000 }))).toEqual({ rps: 1000, p50ms: 1, p99ms: 5 })
  })

  test("rejects partial success, HTTP errors, and empty status counts", () => {
    expect(() => parseOha(sample(0.995, { "200": 995 }))).toThrow("invalid sample")
    expect(() => parseOha(sample(1, { "200": 999, "500": 1 }))).toThrow("invalid sample")
    expect(() => parseOha(sample(1, { "200": 0 }))).toThrow("invalid sample")
    expect(() => parseOha(sample(1, {}))).toThrow("unexpected JSON shape")
  })
})

describe("site slices", () => {
  const result = { rps: 100, p50ms: 1, p99ms: 2, payloadRaw: 1024, payloadGzip: 512 }
  const react = tables("A").find((section) => section.label.startsWith("React"))?.targets ?? []
  // Own-server rows first, so a filter that only took the first Node row would pick them.
  const ordered: SsrBenchTarget[] = [
    ...react.filter((t) => rowKind(t) === "own-server"),
    ...react.filter((t) => rowKind(t) !== "own-server"),
  ]
  const rows = ordered.map((target) => ({
    framework: "React",
    target,
    result: target.name === "nifra+react (node)" ? { ...result, rps: 300 } : result,
  }))
  const versionOf = (target: SsrBenchTarget): string =>
    target.name.startsWith("nifra") ? "5.0.0" : "16.0.0"

  test("own-server rows never reach the hero chart, the bar list or the multipliers", () => {
    for (const slice of [heroSsrSlice(rows, versionOf), frontendSlice(rows, versionOf)]) {
      expect(slice.some((row) => row.name.includes("own server"))).toBe(false)
      expect(slice.map((row) => row.name)).toContain("Nifra + React (Node)")
    }
    expect(multipliersSlice(rows, versionOf)).toEqual([
      { fw: "React", mult: "3×", rival: "Next.js", rivalVersion: "16.0.0" },
    ])
  })

  test("website multipliers use the same paired-round statistic as the console", () => {
    const measured = rows.map((row) => ({
      ...row,
      samples: row.target.name === "nifra+react (node)" ? [100, 1000, 100] : [10, 100, 1000],
    }))
    expect(multipliersSlice(measured, versionOf)).toEqual([
      { fw: "React", mult: "10×", rival: "Next.js", rivalVersion: "16.0.0" },
    ])
  })

  test("the per-framework table names every row kind", () => {
    const names = ssrTablesSlice(rows, versionOf).flatMap((table) =>
      table.rows.map((row) => row.name),
    )
    expect(names).toContain("Nifra + React render API in your own server (Bun)")
    expect(names).toContain("Nifra + React render API in your own server (Node)")
    const b = tables("B").flatMap((section) =>
      nifraRows(section).map((target) => ({
        framework: section.label.split(" - ")[0] ?? "",
        target,
        result,
      })),
    )
    const bNames = ssrTablesSlice(b, versionOf).flatMap((table) =>
      table.rows.map((row) => row.name),
    )
    expect(bNames).toContain("Nifra + Vue SSG (Node)")
    expect(bNames).toContain("Nifra + React ISR (Node)")
    expect(bNames).toContain("Nifra + Svelte SSG files on a static host")
  })

  test("every published row carries its version, and the renderer ceiling is never published", () => {
    const preact = tables("A").find((section) => section.label.startsWith("Preact"))?.targets ?? []
    const preactRows = preact.map((target) => ({ framework: "Preact", target, result }))
    expect(preactRows.map((row) => row.target.name)).toContain("preact-ssr")
    const published = [
      ...ssrTablesSlice([...rows, ...preactRows], versionOf).flatMap((table) => table.rows),
      ...frontendSlice([...rows, ...preactRows], versionOf),
    ]
    expect(published.some((row) => row.name.includes("Preact"))).toBe(true)
    expect(published.some((row) => /raw|ceiling/i.test(row.name))).toBe(false)
    for (const row of published) {
      expect(row.version).toBe(row.name.startsWith("Nifra") ? "5.0.0" : "16.0.0")
    }
  })
})

describe("hydration payload", () => {
  const base = "http://127.0.0.1:4300/"
  // SvelteKit's SSR response when not prerendering: an inline boot script and a `Link` header.
  const svelteKitHtml = `<html><head></head><body><div style="display: contents"></div>
<script>{ Promise.all([import("./_app/immutable/entry/start.js"), import("./_app/immutable/entry/app.js")]) }</script>
</body></html>`
  const svelteKitLink = [
    '<./_app/immutable/entry/start.js>; rel="modulepreload"; nopush',
    '<./_app/immutable/chunks/a.js>; rel="modulepreload"; nopush',
    '<./_app/immutable/entry/app.js>; rel="modulepreload"; nopush',
    '<./_app/immutable/nodes/0.js>; rel="modulepreload"; nopush',
    '<./_app/immutable/assets/0.css>; rel="preload"; as="style"; nopush',
  ].join(", ")

  test("SvelteKit's scripts are read from the Link header", () => {
    expect(clientScriptUrls(svelteKitHtml, base, null)).toEqual([])
    expect(clientScriptUrls(svelteKitHtml, base, svelteKitLink)).toEqual([
      `${base}_app/immutable/entry/start.js`,
      `${base}_app/immutable/chunks/a.js`,
      `${base}_app/immutable/entry/app.js`,
      `${base}_app/immutable/nodes/0.js`,
    ])
  })

  test("script tags and script preloads count once, styles never", () => {
    const html = `<link rel="stylesheet" href="/s.css"><link rel="preload" as="style" href="/p.css">
<link rel="modulepreload" href="/m.js"><link rel="preload" href="/p.js" as="script">
<script type="module" src="/m.js"></script><script src="/e.js"></script>`
    expect(
      clientScriptUrls(html, base, "</m.js>; rel=modulepreload, </l.js>; rel=preload; as=script"),
    ).toEqual([`${base}m.js`, `${base}e.js`, `${base}p.js`, `${base}l.js`])
  })

  test("the payload sums the bytes of every script the Link header names", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => new Response("x".repeat(new URL(req.url).pathname.length * 100)),
    })
    try {
      const payload = await measureHydrationPayload(
        svelteKitHtml,
        `http://127.0.0.1:${server.port}/`,
        svelteKitLink,
      )
      const paths = ["entry/start.js", "chunks/a.js", "entry/app.js", "nodes/0.js"]
      const expected = paths.reduce((sum, p) => sum + `/_app/immutable/${p}`.length * 100, 0)
      expect(payload.raw).toBe(expected)
      expect(payload.gzip).toBeGreaterThan(0)
    } finally {
      server.stop(true)
    }
  })
})

describe("static host paths", () => {
  test("documents and assets map into the static build, traversal does not", () => {
    expect(staticFileFor("/dist", "/")).toBe("/dist/index.html")
    expect(staticFileFor("/dist", "/blog/")).toBe("/dist/blog/index.html")
    expect(staticFileFor("/dist", "/assets/client.js")).toBe("/dist/assets/client.js")
    for (const path of ["relative", "/../secret", "/assets/../secret"]) {
      expect(staticFileFor("/dist", path)).toBeUndefined()
    }
  })
})
