import { describe, expect, test } from "bun:test"
import {
  loadTypesCorpus,
  lookupType,
  renderTypesResult,
  searchTypes,
  type TypeEntry,
} from "../src/types-search.ts"

const TYPES: TypeEntry[] = [
  {
    name: "RateLimitStore",
    kind: "interface",
    package: "@nifrajs/middleware",
    signature:
      "export interface RateLimitStore {\n    hit(key: string, windowMs: number): Promise<RateLimitResult>;\n}",
    doc: "/** Counter backend — a shared store in production. */",
  },
  {
    name: "rateLimit",
    kind: "function",
    package: "@nifrajs/middleware",
    signature: "export declare function rateLimit(options: RateLimitOptions): Middleware;",
  },
  {
    name: "RouteSchema",
    kind: "interface",
    package: "@nifrajs/core",
    signature: "export interface RouteSchema {\n    body?: StandardSchemaV1;\n}",
  },
]

describe("types-search", () => {
  test("lookupType is exact + case-insensitive", () => {
    const hits = lookupType(TYPES, "ratelimitstore")
    expect(hits).toHaveLength(1)
    expect(hits[0]?.name).toBe("RateLimitStore")
  })

  test("renderTypesResult by name → the literal signature + doc", () => {
    const out = renderTypesResult(TYPES, "RateLimitStore", undefined, 5)
    expect(out).toContain("hit(key: string, windowMs: number): Promise<RateLimitResult>")
    expect(out).toContain("Counter backend")
    expect(out).toContain("@nifrajs/middleware")
  })

  test("unknown name → a helpful pointer, not an empty result", () => {
    const out = renderTypesResult(TYPES, "Nope", undefined, 5)
    expect(out).toContain("No exported type named")
    expect(out).toContain("query")
  })

  test("query search finds by keyword across name + signature", () => {
    const matches = searchTypes(TYPES, "rate limit", 5)
    const names = matches.map((m) => m.name)
    expect(names).toContain("RateLimitStore")
    expect(names).toContain("rateLimit")
  })

  test("no name + no query → a per-package index", () => {
    const out = renderTypesResult(TYPES, undefined, undefined, 5)
    expect(out).toContain("# nifra types")
    expect(out).toContain("@nifrajs/middleware")
    expect(out).toContain("RateLimitStore")
  })

  test("the shipped corpus loads and carries the exact RateLimitStore (anti-staleness)", async () => {
    const corpus = await loadTypesCorpus()
    expect(corpus).toBeDefined()
    const hit = lookupType(corpus ?? [], "RateLimitStore")[0]
    expect(hit?.signature).toContain("hit(key: string, windowMs: number): Promise<RateLimitResult>")
    expect(hit?.package).toBe("@nifrajs/middleware")
  })
})
