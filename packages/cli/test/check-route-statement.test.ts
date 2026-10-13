import { afterEach, beforeEach, expect, test } from "bun:test"
import { collectCheckResult } from "../src/check.ts"
import { createFixtureRoot, removeFixtureRoot, writeAppFile } from "./fixture-root.ts"

let root: string

beforeEach(() => {
  root = createFixtureRoot("tmp-check-route-statement-")
})
afterEach(() => removeFixtureRoot(root))

const findings = async (): Promise<readonly string[]> => {
  const result = await collectCheckResult(root, { lintsOnly: true })
  return result.diagnostics
    .filter((diagnostic) => diagnostic.code === "NF-C045")
    .map((diagnostic) => `${diagnostic.file}:${diagnostic.line} ${diagnostic.message}`)
}

test("a registration statement on an exported server is reported, a chained one is not", async () => {
  writeAppFile(
    root,
    "backend/app.ts",
    `import { server } from "@nifrajs/core/server"
const library = server().get("/shelves", () => [])
export const app = server()
  .get("/loans", () => [])
app.post("/loans", () => "ok")
app.group("/staff", (staff) => staff.get("/rota", () => []))
app.merge(library)
app.onError(() => undefined)
`,
  )
  const found = await findings()
  expect(found.map((entry) => entry.split(" ")[0])).toEqual([
    "backend/app.ts:5",
    "backend/app.ts:6",
    "backend/app.ts:7",
  ])
  expect(found[0]).toContain('`app.post("/loans", ...)` is a statement of its own')
})

test("a server read by typeof counts, and createWebApp chains are servers", async () => {
  writeAppFile(
    root,
    "server.ts",
    `import { createWebApp } from "@nifrajs/web"
const site = createWebApp(options).get("/health", () => "ok")
site.get("/ready", () => "ok")
export type Site = typeof site
`,
  )
  expect((await findings()).map((entry) => entry.split(" ")[0])).toEqual(["server.ts:3"])
})

test("a server whose type never leaves the file is not reported", async () => {
  writeAppFile(
    root,
    "server.ts",
    `import { createWebApp } from "@nifrajs/web"
const site = createWebApp(options)
site.get("/assets/*", () => "file")
export default { fetch: site.fetch }
`,
  )
  expect(await findings()).toEqual([])
})

test("nifra-expect with a reason accepts a statement kept off the type", async () => {
  writeAppFile(
    root,
    "backend/app.ts",
    `import { server } from "@nifrajs/core/server"
export const app = server().get("/loans", () => [])
// nifra-expect NF-C045: served to crawlers only, never called by the client
app.get("/sitemap.xml", () => "xml")
// nifra-expect NF-C045
app.get("/robots.txt", () => "txt")
`,
  )
  expect((await findings()).map((entry) => entry.split(" ")[0])).toEqual(["backend/app.ts:6"])
})
