import { afterAll, expect, spyOn, test } from "bun:test"
import { cp, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { server, VERSION } from "../src/index.ts"

/**
 * A second physical copy of this package, loaded into this process the way a linked sibling checkout
 * or a nested install loads one: its own `package.json` (so its `@nifrajs/core/*` self-imports resolve
 * inside the copy) and its own `src`, at a different path.
 */
const COPIES = Symbol.for("nifra.core.copies")
const registry = (globalThis as unknown as Record<symbol, string[]>)[COPIES] as string[]
const loadedBefore = [...registry]
const here = loadedBefore.find((url) => url.endsWith("/src/server/core-copies.ts"))
const ground = await realpath(await mkdtemp(join(tmpdir(), "nifra-core-copies-")))

afterAll(async () => {
  // The list is process-wide: leave it as this file found it for every later test file.
  registry.splice(0, registry.length, ...loadedBefore)
  await rm(ground, { recursive: true, force: true })
})

const copyOfCore = async (label: string): Promise<string> => {
  const dir = join(ground, label)
  await cp(join(import.meta.dir, "..", "src"), join(dir, "src"), { recursive: true })
  await cp(join(import.meta.dir, "..", "package.json"), join(dir, "package.json"))
  return join(dir, "src", "index.ts")
}

test("this copy registers itself once", () => {
  expect(loadedBefore.filter((url) => url.endsWith("/src/server/core-copies.ts"))).toHaveLength(1)
})

test("merge() refuses a value that is not a server", () => {
  const saved = [...registry]
  registry.splice(0, registry.length, ...(here === undefined ? [] : [here]))
  try {
    // With one copy loaded the message names no copies: the value is just not a server.
    const app = server()
    expect(() => Reflect.apply(app.merge, app, [{}])).toThrow(
      /^merge\(\) requires a server\(\) from this copy of @nifrajs\/core$/,
    )
  } finally {
    registry.splice(0, registry.length, ...saved)
  }
})

test("a copy older than the version record is named by its URL alone", () => {
  if (here === undefined) throw new Error("this copy did not register")
  const saved = [...registry]
  registry.splice(0, registry.length, here, "file:///old/@nifrajs/core/dist/server/core-copies.js")
  try {
    const app = server()
    expect(() => Reflect.apply(app.merge, app, [{}])).toThrow(
      "other copy: file:///old/@nifrajs/core/dist/server/core-copies.js\n",
    )
  } finally {
    registry.splice(0, registry.length, ...saved)
  }
})

test("a second copy warns once when it loads, and merge() refuses its servers by name", async () => {
  if (here === undefined) throw new Error("this copy did not register")
  // Bundles other test files imported into this process are copies too, and test file order
  // differs by platform: count from this copy alone (afterAll restores the list).
  registry.splice(0, registry.length, here)
  const entry = await copyOfCore("second")
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  let other: typeof import("../src/index.ts")
  let warnings: unknown[][]
  try {
    other = await import(entry)
    // A dev server re-evaluating the same file (a query-busted URL) is the same copy, not a third.
    await import(`${entry}?reload=1`)
    warnings = [...warn.mock.calls]
  } finally {
    warn.mockRestore()
  }
  expect(warnings).toHaveLength(1)
  const message = String(warnings[0]?.[0])
  expect(message).toContain("@nifrajs/core is loaded 2 times")
  expect(message).toContain("nifra check")
  expect(message).toContain(pathToFileURL(join(ground, "second", "src", "server")).href)
  expect(message).toContain(here)

  // Before: this merged, then answered the request with a 500 (the other copy's route reached this
  // copy's private request state through a symbol it does not share).
  const foreign = other.server().get("/x", (c) => {
    c.set.cookie("k", "v")
    return { ok: true }
  })
  expect(() => server().merge(foreign)).toThrow("from this copy of @nifrajs/core")
  let refusal = ""
  try {
    server().merge(foreign)
  } catch (error) {
    refusal = String(error)
  }
  expect(refusal).toContain("2 copies are loaded")
  expect(refusal).toContain(`this copy:  ${here} (${VERSION})`)
  expect(refusal).toContain(
    `other copy: ${pathToFileURL(join(ground, "second", "src", "server", "core-copies.ts")).href} (${VERSION})`,
  )
  expect(refusal).toContain("nifra upgrade <version> --write")

  // A mount crosses only the fetch boundary, so the same route keeps working across copies.
  const mounted = server().mount({ path: "/m", app: foreign, stripPrefix: true })
  const response = await mounted.fetch(new Request("http://h/m/x"))
  expect(response.status).toBe(200)
  expect(response.headers.get("set-cookie")).toContain("k=v")
})

test("whichever copy loads second is the one that warns", async () => {
  if (here === undefined) throw new Error("this copy did not register")
  const saved = [...registry]
  // Another install got here first, so this file, evaluated again, is the second copy.
  registry.splice(0, registry.length, "file:///elsewhere/@nifrajs/core/src/server/core-copies.ts")
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  const VERSIONS = Symbol.for("nifra.core.copy-versions")
  const versions: unknown = Reflect.get(globalThis, VERSIONS)
  try {
    const second = await import(`${fileURLToPath(here)}?loaded-second`)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain("@nifrajs/core is loaded 2 times")
    // The copy that loaded second names both: itself with the version it records (into a fresh
    // process-wide map here), the earlier one by URL alone, as a copy that recorded none.
    Reflect.deleteProperty(globalThis, VERSIONS)
    second.recordCopyVersion()
    const refusal = second.mergeRefusal()
    expect(refusal).toContain(`this copy:  ${here} (${VERSION})`)
    expect(refusal).toContain(
      "other copy: file:///elsewhere/@nifrajs/core/src/server/core-copies.ts\n",
    )
    registry.splice(0, registry.length, here)
    expect(second.mergeRefusal()).toBe(
      "merge() requires a server() from this copy of @nifrajs/core",
    )
  } finally {
    warn.mockRestore()
    registry.splice(0, registry.length, ...saved)
    Reflect.set(globalThis, VERSIONS, versions)
  }
})
