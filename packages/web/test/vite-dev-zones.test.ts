import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { createViteDevServer, type ViteDevServer } from "../src/vite.ts"

// The Vite dev server serves source by URL, so the zones have to hold before a byte is sent, whatever
// form the URL takes. This drives the real server and reads what it answers.
const TMP_BASE = `${import.meta.dir}/.tmp-vite-dev-zones-`
const SECRET = "do-not-serve-this-backend-source"
let root: string
let server: ViteDevServer | undefined
let origin: string

const write = (path: string, text: string): void => {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

beforeAll(async () => {
  root = mkdtempSync(TMP_BASE)
  write("routes/index.tsx", "export default function Index() { return null }\n")
  write("routes/index.backend.ts", `export const loader = () => "${SECRET}"\n`)
  write("backend/db.ts", `export const url = "${SECRET}"\n`)
  write(
    "backend/notes.fn.ts",
    `import { serverFn } from "@nifrajs/web/fn"\nexport const note = serverFn(async () => "${SECRET}")\n`,
  )
  write("frontend/client.ts", "export function mountRouter() {}\n")
  write("frontend/leaky.ts", 'import { url } from "../backend/db.ts"\nexport const leaked = url\n')
  write(
    "frontend/rpc.ts",
    'import { note } from "../backend/notes.fn.ts"\nexport const call = note\n',
  )
  write("lib/loose.ts", `export const loose = "${SECRET}"\n`)
  write("shared/config.ts", "export const db = process.env.DATABASE_URL\n")
  write("frontend/public-config.ts", "export const api = import.meta.env.PUBLIC_API\n")
  server = await createViteDevServer({
    root,
    routesDir: join(root, "routes"),
    clientModule: join(root, "frontend/client.ts"),
    port: 0,
    createApp: () => ({ fetch: () => new Response("app") }),
  })
  origin = `http://127.0.0.1:${server.port}`
}, 60_000)

afterAll(async () => {
  await server?.stop()
  rmSync(root, { recursive: true, force: true })
})

describe("a browser request for server code gets a 403, whatever the URL form", () => {
  test.each([
    "/backend/db.ts",
    "/backend/db.ts?import",
    "/backend/db.ts?raw",
    "/backend/db.ts?url",
    "/backend/db.ts.map",
    "/routes/index.backend.ts",
    "/routes/index.backend.ts?t=1",
    "/backend/notes.fn.ts?raw",
    "/lib/loose.ts",
  ])("%s", async (path) => {
    const response = await fetch(`${origin}${path}`)
    const body = await response.text()
    expect(response.status).toBe(403)
    expect(body).toContain("may not reach the browser")
    expect(body).not.toContain(SECRET)
  })

  test("/@fs/ with the absolute path", async () => {
    // Vite's spelling everywhere: `/@fs/C:/app/db.ts` on Windows, `/@fs/app/db.ts` elsewhere.
    const absolute = join(root, "backend/db.ts").replaceAll("\\", "/").replace(/^\//, "")
    const response = await fetch(`${origin}/@fs/${absolute}`)
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain(SECRET)
  })

  test("/@id/ with the absolute path", async () => {
    const response = await fetch(`${origin}/@id/${join(root, "backend/db.ts")}`)
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain(SECRET)
  })

  test("a pre-bundled dependency is judged by the source Vite built it from", async () => {
    write(
      "node_modules/.vite/nifra-test/_metadata.json",
      JSON.stringify({ optimized: { db: { src: "../../../backend/db.ts", file: "db.js" } } }),
    )
    write("node_modules/.vite/nifra-test/db.js", `export const url = "${SECRET}"\n`)
    const response = await fetch(`${origin}/node_modules/.vite/nifra-test/db.js`)
    const body = await response.text()
    expect(response.status).toBe(403)
    expect(body).toContain("backend/db.ts may not reach the browser")
    expect(body).not.toContain(SECRET)
  })
})

describe("a request that names no app file is left to Vite", () => {
  test.each([
    ["an /@id/ that is not a path", "/@id/virtual-module"],
    ["a malformed escape", "/%E0%A4%A"],
    ["a cache file whose metadata does not parse", "/node_modules/.vite/broken/x.js"],
    ["a cache file with no metadata", "/node_modules/.vite/nometa/y.js"],
  ])("%s", async (_name, path) => {
    write("node_modules/.vite/broken/_metadata.json", "{ not json")
    write("node_modules/.vite/broken/x.js", "export const x = 1\n")
    write("node_modules/.vite/nometa/y.js", "export const y = 1\n")
    const response = await fetch(`${origin}${path}`)
    expect(response.status).not.toBe(403)
    expect(await response.text()).not.toContain("may not reach the browser")
  })
})

describe("browser code is served", () => {
  test("a route's frontend half", async () => {
    const response = await fetch(`${origin}/routes/index.tsx`)
    expect(response.status).toBe(200)
  })

  test("a server function only as its stub", async () => {
    const response = await fetch(`${origin}/backend/notes.fn.ts`)
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).toContain("/_nifra/fn/notes")
    expect(body).not.toContain(SECRET)
  })
})

test("a frontend module importing backend code fails at the import, naming both files", async () => {
  const response = await fetch(`${origin}/frontend/leaky.ts`)
  const body = await response.text()
  expect(response.status).toBe(500)
  expect(body).toContain("backend/db.ts may not reach the browser (imported by frontend/leaky.ts)")
  expect(body).not.toContain(SECRET)
})

test("browser code reading a private environment variable fails; a public one is served", async () => {
  const refused = await fetch(`${origin}/shared/config.ts`)
  expect(refused.status).toBe(500)
  expect(await refused.text()).toContain(
    "shared/config.ts may not reach the browser: it reads private environment variable process.env.DATABASE_URL",
  )
  const served = await fetch(`${origin}/frontend/public-config.ts`)
  expect(served.status).toBe(200)
})
