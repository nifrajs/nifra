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
    const response = await fetch(`${origin}/@fs${join(root, "backend/db.ts")}`)
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain(SECRET)
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
