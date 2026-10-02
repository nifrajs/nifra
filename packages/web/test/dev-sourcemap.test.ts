import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSourceMapper, decodeMappings } from "../src/dev-sourcemap.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const ORIGIN = "http://127.0.0.1:4100"

/** A project with one route module, bundled the way a dev server would serve it. */
const bundle = async (
  sourcemap: "linked" | "inline",
): Promise<{ root: string; source: string; files: Map<string, string> }> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nifra-sourcemap-")))
  roots.push(root)
  mkdirSync(join(root, "routes"))
  const source = join(root, "routes", "index.ts")
  writeFileSync(
    source,
    [
      "export function render(id: number): string {",
      '  const label: string = "item " + id',
      '  if (id > 1) throw new TypeError("MARKER " + label)',
      "  return label",
      "}",
      "",
    ].join("\n"),
  )
  const result = await Bun.build({ entrypoints: [source], sourcemap, outdir: join(root, "out") })
  const files = new Map<string, string>()
  for (const output of result.outputs) {
    // Served from where it was built, so the map's relative sources resolve as they would on disk.
    files.set(`/out/${output.path.split("/").at(-1)}`, await output.text())
  }
  return { root, source, files }
}

/** The 1-based line/column of `needle` in the generated script, as a browser would report it. */
const positionOf = (script: string, needle: string): { line: number; column: number } => {
  const lines = script.split("\n")
  const line = lines.findIndex((text) => text.includes(needle))
  return { line: line + 1, column: (lines[line]?.indexOf(needle) ?? 0) + 1 }
}

const serving = (files: Map<string, string>, seen: string[] = []) => ({
  fetch: async (url: string): Promise<Response> => {
    seen.push(url)
    const body = files.get(new URL(url).pathname)
    return body === undefined ? new Response("missing", { status: 404 }) : new Response(body)
  },
})

test("VLQ: decodes absolute positions across segments and lines", () => {
  // Line 0: col 0 -> src 0 line 0 col 0; col 4 -> line 1 col 2. Line 1: col 2 -> line 2 col 0.
  const lines = decodeMappings("AAAA,IACE;EACF")
  expect([...(lines[0] ?? [])]).toEqual([0, 0, 0, 0, 4, 0, 1, 2])
  expect([...(lines[1] ?? [])]).toEqual([2, 0, 2, 0])
  expect(() => decodeMappings("AA!A")).toThrow("invalid VLQ")
})

for (const sourcemap of ["linked", "inline"] as const) {
  test(`a ${sourcemap} map points a Chrome frame at the source line`, async () => {
    const { root, source, files } = await bundle(sourcemap)
    const [[path, script] = ["", ""]] = [...files].filter(([name]) => name.endsWith(".js"))
    const at = positionOf(script, "throw new TypeError")
    const mapper = createSourceMapper({ root, origin: () => ORIGIN, ...serving(files) })
    const stack = [
      "TypeError: MARKER item 2",
      `    at render (http://localhost:4100${path}:${at.line}:${at.column})`,
    ].join("\n")
    expect(await mapper.mapStack(stack)).toBe(
      ["TypeError: MARKER item 2", `    at render (${source}:3:15)`].join("\n"),
    )
  })
}

test("a Firefox/Safari stack comes out as V8 frames", async () => {
  const { root, source, files } = await bundle("linked")
  const [[path, script] = ["", ""]] = [...files].filter(([name]) => name.endsWith(".js"))
  const at = positionOf(script, "throw new TypeError")
  const mapper = createSourceMapper({ root, origin: () => ORIGIN, ...serving(files) })
  const mapped = await mapper.mapStack(
    `render@${ORIGIN}${path}:${at.line}:${at.column}\n@https://cdn.example.com/lib.js:4:2`,
  )
  expect(mapped.split("\n")).toEqual([
    `    at render (${source}:3:15)`,
    "    at https://cdn.example.com/lib.js:4:2",
  ])
})

test("frames of other servers and of pages are left alone and never fetched", async () => {
  const seen: string[] = []
  const mapper = createSourceMapper({
    root: tmpdir(),
    origin: () => ORIGIN,
    ...serving(new Map(), seen),
  })
  const stack = [
    "Error: boom",
    "    at a (https://cdn.example.com/lib.js:1:10)",
    "    at b (http://127.0.0.1:9999/x.js:1:10)",
    "    at c (http://127.0.0.1:4100/users/1:12:3)",
    "    at d (http://127.0.0.1:4100/_bun/client/x.js:1:1)",
  ].join("\n")
  expect(await mapper.mapStack(stack)).toBe(stack)
  // Only the same-server script was asked for; the page URL (an inline script's frame) never is.
  expect(seen).toEqual([`${ORIGIN}/_bun/client/x.js`])
})

test("a map is fetched once per script until the code changes", async () => {
  const { root, files } = await bundle("linked")
  const [[path] = [""]] = [...files].filter(([name]) => name.endsWith(".js"))
  const seen: string[] = []
  const mapper = createSourceMapper({ root, origin: () => ORIGIN, ...serving(files, seen) })
  const stack = `Error: x\n    at ${ORIGIN}${path}:1:1`
  await mapper.mapStack(stack)
  await mapper.mapStack(stack)
  expect(seen).toHaveLength(2) // the script, then its map
  mapper.clear()
  await mapper.mapStack(stack)
  expect(seen).toHaveLength(4)
})

test("a map hosted on another origin is not followed", async () => {
  const seen: string[] = []
  const files = new Map([["/x.js", "1\n//# sourceMappingURL=https://evil.example/x.js.map\n"]])
  const mapper = createSourceMapper({
    root: tmpdir(),
    origin: () => ORIGIN,
    ...serving(files, seen),
  })
  const stack = `Error: x\n    at ${ORIGIN}/x.js:1:1`
  expect(await mapper.mapStack(stack)).toBe(stack)
  expect(seen).toEqual([`${ORIGIN}/x.js`])
})

test("relative map sources resolve against the script's path inside the root", async () => {
  // Vite serves /routes/index.tsx with an inline map whose sources are relative to that URL.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nifra-sourcemap-")))
  roots.push(root)
  const map = { version: 3, sources: ["index.tsx"], names: [], mappings: "AAEA" }
  const script = `x()\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}\n`
  const mapper = createSourceMapper({
    root,
    origin: () => ORIGIN,
    ...serving(new Map([["/routes/index.tsx", script]])),
  })
  expect(await mapper.mapStack(`Error: x\n    at ${ORIGIN}/routes/index.tsx?t=1:1:1`)).toBe(
    `Error: x\n    at ${join(root, "routes", "index.tsx")}:3:1`,
  )
})

test("a module Vite serves from outside the root (/@fs/) maps to its real path", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nifra-sourcemap-")))
  roots.push(root)
  const dep = join(tmpdir(), "elsewhere", "node_modules", "lib", "index.js")
  const map = { version: 3, sources: ["index.ts"], names: [], mappings: "AAAA" }
  const script = `x()\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}\n`
  const servedAt = `/@fs${dep}`
  const mapper = createSourceMapper({
    root,
    origin: () => ORIGIN,
    ...serving(new Map([[servedAt, script]])),
  })
  expect(await mapper.mapStack(`Error: x\n    at ${ORIGIN}${servedAt}?v=1:1:1`)).toBe(
    `Error: x\n    at ${join(tmpdir(), "elsewhere", "node_modules", "lib", "index.ts")}:1:1`,
  )
})
