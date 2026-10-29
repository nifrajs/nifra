import { expect, test } from "bun:test"
import { frontendCommandInput } from "../src/cli.ts"
import {
  parseRuntime,
  RUNTIME_DIFFERENCES,
  renderRuntimeResult,
  selectRuntimeDifferences,
} from "../src/runtime-differences.ts"

test("no args renders the full index with every entry id", () => {
  const index = renderRuntimeResult({})
  expect(index).toContain(`${RUNTIME_DIFFERENCES.length} of ${RUNTIME_DIFFERENCES.length}`)
  for (const e of RUNTIME_DIFFERENCES) expect(index).toContain(e.id)
})

test("every entry is complete, has a unique id and names the versions it was measured on", () => {
  const ids = new Set<string>()
  for (const e of RUNTIME_DIFFERENCES) {
    expect(ids.has(e.id)).toBe(false)
    ids.add(e.id)
    for (const field of [e.symptom, e.cause, e.fix, e.verify])
      expect(field.length).toBeGreaterThan(20)
    expect(e.versions.length).toBeGreaterThan(0)
    expect(e.runtimes.length).toBeGreaterThan(0)
    for (const r of e.runtimes) expect(parseRuntime(r)).toBe(r)
  }
})

test("a symptom query returns the matching entry in full", () => {
  const out = renderRuntimeResult({ symptom: "path guard skipped dot segments" })
  expect(out).toContain("[dot-segment-targets]")
  for (const label of ["Symptom:", "Cause:", "Fix:", "Verify:", "Measured:"]) {
    expect(out).toContain(label)
  }
})

test("the runtime filter keeps that runtime's entries and drops the others'", () => {
  const deno = renderRuntimeResult({ runtime: "deno" })
  expect(deno).toContain("host-builds-url")
  expect(deno).not.toContain("glob-symlinks") // Bun only
  expect(deno).not.toContain("workerd-node-builtins")
  const bun = selectRuntimeDifferences({ runtime: "bun" })
  expect(bun.entries.some((e) => e.id === "glob-symlinks")).toBe(true)
  expect(bun.entries.some((e) => e.id === "workerd-node-builtins")).toBe(false)
})

test("a query that matches nothing says so and falls back to the index", () => {
  const out = renderRuntimeResult({ symptom: "zzzzqqqq" })
  expect(out).toStartWith('No runtime-difference entry matched "zzzzqqqq"')
  expect(out).toContain(RUNTIME_DIFFERENCES[0]!.id)
})

test("runtime names and common aliases parse; anything else does not", () => {
  expect(parseRuntime("Node")).toBe("node")
  expect(parseRuntime("workers")).toBe("workerd")
  expect(parseRuntime("cloudflare")).toBe("workerd")
  expect(parseRuntime("python")).toBeUndefined()
  expect(parseRuntime(undefined)).toBeUndefined()
})

test("the JSON shape carries the schema version, the runtime and the entries", () => {
  const result = selectRuntimeDifferences({ runtime: "node", symptom: "pipelined requests" })
  expect(result.schemaVersion).toBe(1)
  expect(result.runtime).toBe("node")
  expect(result.matched).toBe(true)
  expect(result.entries[0]?.id).toBe("pipelined-requests")
})

test("the CLI splits a runtime from the symptom and keeps --json out of it", () => {
  const input = frontendCommandInput(["deno", "path", "guard", "--json"], parseRuntime)
  expect(input).toEqual({ adapter: "deno", symptom: "path guard", json: true })
})

// The claims below are about the runtime this suite runs on. If a Bun release changes one, this fails
// and the entry (and its `versions`) is updated, instead of the catalog quietly going stale.
test("the Bun behaviors the catalog states still hold on this Bun", async () => {
  expect(() => JSON.parse("{")).toThrow("JSON Parse error: Expected '}'")
  expect(Response.json({ a: 1 }).headers.get("content-type")).toBe("application/json;charset=utf-8")
  const deep = (n: number): number => (n === 0 ? 0 : deep(n - 1))
  expect(deep(200_000)).toBe(0)
  expect(() => new URL("not a url")).toThrow("Invalid URL")
})

test("the docs page names every runtime entry, so it cannot fall behind the catalog", async () => {
  const page = await Bun.file(
    new URL("../../../site/routes/docs/runtime-differences.tsx", import.meta.url),
  ).text()
  for (const e of RUNTIME_DIFFERENCES) expect(page, e.id).toContain(`<code>${e.id}</code>`)
})
