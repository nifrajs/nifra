import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  capturedMeta,
  httpFrameworkVersion,
  httpRealworldFromResults,
  httpWorkloadsFromResults,
  type LegacySiteBench,
  mergeSiteBench,
  NIFRA_VERSION,
  packageVersion,
  type SiteBench,
} from "./site-bench.ts"

const runtimes = { bun: "1.4.3", node: "v26.12.0", deno: "2.9.7" }
const cell = (rps: number) => ({ rps })
const RAW = ["bun-native", "node-raw", "deno-raw"]

describe("published HTTP slices", () => {
  const bare = {
    bun: {
      nifra: { "GET /users/:id": cell(120), "POST /users": cell(100) },
      elysia: { "GET /users/:id": cell(119), "POST /users": cell(99) },
      "bun-native": { "GET /users/:id": cell(121), "POST /users": cell(101) },
    },
    node: {
      nifra: { "GET /users/:id": cell(90), "POST /users": cell(70) },
      "node-raw": { "GET /users/:id": cell(80), "POST /users": cell(71) },
    },
    deno: { "deno-raw": { "GET /users/:id": cell(110), "POST /users": cell(105) } },
  }

  test("raw-runtime rows are measured but never published", () => {
    const tables = httpWorkloadsFromResults(bare, runtimes)
    const names = tables.flatMap((table) => table.rows.map((row) => row.name))
    expect(names).toEqual(["Nifra", "Elysia", "Nifra"])
    for (const raw of RAW) expect(names).not.toContain(raw)
    // A runtime whose only measured row is its raw server publishes no table at all.
    expect(tables.map((table) => table.title)).toEqual(["Bun", "Node"])
  })

  test("every row carries the version it measured, every table its runtime's", () => {
    const [bun, node] = httpWorkloadsFromResults(bare, runtimes)
    expect(bun?.version).toBe("1.4.3")
    expect(node?.version).toBe("26.12.0")
    expect(bun?.rows.map((row) => row.version)).toEqual([NIFRA_VERSION, packageVersion("elysia")])
  })

  test("the realistic slice drops raw rows and versions the rest", () => {
    const workloads = { get: "get", post: "post", body: "body" }
    const realworld = {
      bun: {
        nifra: { get: cell(80), post: cell(78) },
        "nifra-body": { body: cell(64) },
        "bun-native": { get: cell(87), post: cell(89) },
        "bun-native-body": { body: cell(69) },
      },
    }
    expect(httpRealworldFromResults(realworld, workloads, runtimes)).toEqual([
      {
        title: "Bun",
        version: "1.4.3",
        rows: [
          { name: "Nifra", version: NIFRA_VERSION, get: "80", post: "78", body: "64", nifra: true },
        ],
      },
    ])
  })

  test("a framework with no recorded package, or a package not installed, is refused", () => {
    expect(() => httpFrameworkVersion("bun-native")).toThrow("no package recorded")
    expect(() => packageVersion("nifra-no-such-package-installed")).toThrow("no installed")
  })

  test("a capture record names bare versions and today's date", () => {
    const today = new Date().toISOString().slice(0, 10)
    expect(capturedMeta({ ...runtimes, oha: "1.16.0" })).toEqual({
      date: today,
      bun: "1.4.3",
      node: "26.12.0",
      deno: "2.9.7",
      oha: "1.16.0",
    })
    // The SSR suite runs no Deno target, so its record names none.
    expect(capturedMeta({ bun: "1.4.3", node: "v26.12.0", oha: "1.16.0" })).toEqual({
      date: today,
      bun: "1.4.3",
      node: "26.12.0",
      oha: "1.16.0",
    })
  })
})

describe("the committed site dataset", () => {
  const data: SiteBench = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "site", "shared", "data", "benchmarks.json"), "utf8"),
  )

  test("a legacy Node memory capture is normalized before a partial runtime update", () => {
    const nodeCapture = data.httpMemory?.node
    const bunCapture = data.httpMemory?.bun
    if (nodeCapture === undefined || bunCapture === undefined)
      throw new Error("[test] committed Node and Bun memory captures are required")
    const { runtime, runtimeVersion, ...legacyMemory } = nodeCapture
    expect(runtime).toBe("node")
    expect(runtimeVersion).toBe(nodeCapture.node)

    const legacyData: LegacySiteBench = { ...data, httpMemory: legacyMemory }
    const merged = mergeSiteBench(legacyData, { httpMemory: { bun: bunCapture } })
    expect(merged.httpMemory).toEqual({
      node: { ...legacyMemory, runtime: "node", runtimeVersion: legacyMemory.node },
      bun: bunCapture,
    })
  })

  const published: ReadonlyArray<
    readonly [string, ReadonlyArray<{ readonly name: string; readonly version: string }>]
  > = [
    ["heroSsr", data.heroSsr],
    ["frontend", data.frontend],
    ["http", data.http],
    ["bundle", data.bundle],
    ["httpWorkloads", (data.httpWorkloads ?? []).flatMap((table) => table.rows)],
    ["httpRealworld", (data.httpRealworld ?? []).flatMap((table) => table.rows)],
    ["ssrTables", (data.ssrTables ?? []).flatMap((table) => table.rows)],
    ["ssrTablesB", (data.ssrTablesB ?? []).flatMap((table) => table.rows)],
  ]

  test("every published row names its version", () => {
    for (const [slice, rows] of published) {
      for (const row of rows) {
        expect({ slice, name: row.name, version: row.version }).toEqual({
          slice,
          name: row.name,
          version: expect.stringMatching(/^\d+\.\d+\.\d+/),
        })
      }
    }
    for (const table of [...(data.httpWorkloads ?? []), ...(data.httpRealworld ?? [])]) {
      expect(table.version).toMatch(/^\d+\.\d+\.\d+/)
    }
    for (const multiplier of data.multipliers) {
      expect(multiplier.rivalVersion).toMatch(/^\d+\.\d+\.\d+/)
    }
  })

  test("no raw baseline row is published", () => {
    // Preact has no meta-framework on Node, so its table compares with the bare renderer: the one raw row.
    const renderer = new Set<unknown>(
      (data.ssrTables ?? [])
        .filter((table) => table.framework === "Preact")
        .flatMap((table) =>
          table.rows.filter((row) => row.name === "Raw Preact render (Node, ceiling)"),
        ),
    )
    for (const [, rows] of published) {
      for (const row of rows) {
        expect(RAW).not.toContain(row.name)
        if (renderer.has(row)) continue
        expect(row.name).not.toMatch(/\braw\b|ceiling/i)
      }
    }
    expect(data).not.toHaveProperty("httpRuntime")
  })

  test("each measured slice carries its own capture record", () => {
    const records = [
      [data.httpWorkloads, data.httpWorkloadsCaptured],
      [data.httpRealworld, data.httpRealworldCaptured],
      [data.ssrTables, data.ssrCaptured],
    ] as const
    for (const [slice, captured] of records) {
      if (slice === undefined) continue
      expect(captured?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      for (const version of [captured?.bun, captured?.node, captured?.oha]) {
        expect(version).toMatch(/^\d+\.\d+\.\d+/)
      }
    }
    expect(data.httpWorkloadsCaptured?.deno).toMatch(/^\d+\.\d+\.\d+/)
    expect(data.httpRealworldCaptured?.deno).toMatch(/^\d+\.\d+\.\d+/)
    expect(data).not.toHaveProperty("captured")
  })
})
