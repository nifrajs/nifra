/**
 * A page shipped inside a native shell, end to end against a real server: its origin is
 * `tauri://localhost`, every request goes out through `serverFetch`, and the server decides who may
 * call it. Covers the socket, a server function and the two client builds.
 */
import { afterAll, afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { server } from "@nifrajs/core"
import { t } from "@nifrajs/schema"
import { buildClientVite } from "../src/build-vite.ts"
import { SERVER_FN_PREFIX, serverFn, serverFunctions } from "../src/fn.ts"
import { createWebApp, type Manifest, type RenderAdapter } from "../src/index.ts"
import { generateServerFnStub } from "../src/internal/server-boundary.ts"
import { live } from "../src/live.ts"
import { liveClient } from "../src/live-client.ts"
import type { LoaderContext } from "../src/manifest.ts"
import { createClientRouter } from "../src/router.ts"
import { serverFetch } from "../src/server-fetch.ts"

const SHELL = "tauri://localhost"
const SLOT = Symbol.for("nifra.fetch")

const stub: RenderAdapter = {
  renderToStream: () =>
    new ReadableStream({
      start(c) {
        c.close()
      },
    }),
  hydrationHead: () => "",
}

const saved = {
  WebSocket: Reflect.get(globalThis, "WebSocket"),
  location: Reflect.get(globalThis, "location"),
}
const stops: (() => void)[] = []
const dirs: string[] = []
afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  Reflect.deleteProperty(globalThis, SLOT)
  Reflect.set(globalThis, "WebSocket", saved.WebSocket)
  if (saved.location === undefined) Reflect.deleteProperty(globalThis, "location")
  else Reflect.set(globalThis, "location", saved.location)
})
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

async function until(ok: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 50_000; turn++) {
    if (ok()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`[test] never: ${what}`)
}

function liveServer(trustedOrigins: readonly string[]) {
  const runs = { post: 0 }
  const values = { post: 1 }
  const runtime = live({
    secret: "shell-e2e-secret-0123456789abcdef",
    subject: () => null,
    trustedOrigins,
  })
  const manifest: Manifest = {
    routes: [
      {
        id: "posts/[id]",
        pattern: "/posts/:id",
        layoutIds: [],
        layoutParams: [],
        file: "posts/[id].tsx",
        load: async () => ({
          default: "post",
          loader: (ctx: LoaderContext) => {
            runs.post++
            ctx.live(`post:${ctx.params.id}`)
            return { id: ctx.params.id, value: values.post }
          },
        }),
      },
    ],
    layouts: {},
    notFound: { file: "_404.tsx", load: async () => ({ default: "nf" }) },
  }
  const app = createWebApp({ adapter: stub, manifest, clientEntry: "/c.js", live: runtime })
  const running = app.listen(0, { hostname: "127.0.0.1" })
  stops.push(() => running.stop(true))
  return { runtime, runs, values, base: `http://127.0.0.1:${running.port}` }
}

/** What a webview page sends: its own `Origin` on the socket handshake and on every request. */
function shellPage(base: string) {
  const Native = WebSocket
  Reflect.set(globalThis, "WebSocket", function FromShell(url: string) {
    return Reflect.construct(Native, [url, { headers: { origin: SHELL } }])
  })
  Reflect.set(globalThis, "location", { href: `${SHELL}/`, origin: SHELL })
  const sent: string[] = []
  const transport = serverFetch({
    origin: base,
    headers: { origin: SHELL },
    fetch: (input, init) => {
      sent.push(input)
      return fetch(input, init)
    },
  })
  const client = liveClient({
    layoutIdsOf: { "posts/[id]": [] },
    fetch: transport,
    origin: transport.origin,
  })
  const router = createClientRouter({
    patterns: [{ routeId: "posts/[id]", pattern: "/posts/:id" }],
    initial: {
      routeId: "posts/[id]",
      params: { id: "1" },
      path: "/posts/1",
      data: { id: "1", value: 0 },
      layoutData: [],
      pending: false,
    },
    fetchData: client.fetchData,
    fetch: transport,
  })
  return { client, router, sent }
}

test("a shell page's live socket connects to the server and a published write reaches it", async () => {
  const s = liveServer([SHELL])
  const page = shellPage(s.base)
  stops.push(page.client.attach(page.router))
  await until(() => s.runs.post === 1 && !page.router.snapshot().pending, "first live load")
  s.values.post = 2
  let delivered = false
  for (let attempt = 0; attempt < 50 && !delivered; attempt++) {
    await s.runtime.publish("post:1")
    for (let turn = 0; turn < 2_000 && !delivered; turn++) {
      await new Promise((resolve) => setImmediate(resolve))
      delivered = s.runs.post >= 2 && !page.router.snapshot().pending
    }
  }
  expect(delivered).toBe(true)
  expect(page.router.snapshot().data).toEqual({ id: "1", value: 2 })
  // Every request went to the server's origin, none to the shell's.
  expect(page.sent.length).toBeGreaterThan(0)
  expect(page.sent.every((url) => url.startsWith(`${s.base}/_nifra/live/load`))).toBe(true)
})

test("a server that does not list the shell refuses its live load and its socket", async () => {
  const refusing = liveServer([])
  const trusting = liveServer([SHELL])
  const post = (base: string) =>
    serverFetch({ origin: base, headers: { origin: SHELL } })("/_nifra/live/load", {
      method: "POST",
      body: "{}",
    })
  expect((await post(refusing.base)).status).toBe(403)
  expect((await post(trusting.base)).status).not.toBe(403)
  const opens = (base: string) =>
    new Promise<boolean>((resolve) => {
      const socket: WebSocket = Reflect.construct(WebSocket, [
        `${base.replace("http", "ws")}/_nifra/live`,
        { headers: { origin: SHELL } },
      ])
      socket.onopen = () => {
        socket.close()
        resolve(true)
      }
      socket.onerror = () => resolve(false)
      socket.onclose = () => resolve(false)
    })
  expect(await opens(trusting.base)).toBe(true)
  expect(await opens(refusing.base)).toBe(false)
})

const fns = {
  add: serverFn(
    { input: t.object({ text: t.string() }), output: t.object({ added: t.string() }) },
    ({ text }) => ({ added: text }),
  ),
}

function fnServer(origins: readonly string[]) {
  const app = server().use(serverFunctions("todos", fns, { origins }))
  const running = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => app.fetch(req) })
  stops.push(() => running.stop(true))
  return `http://127.0.0.1:${running.port}`
}

async function stubbedAdd(): Promise<(input: unknown) => Promise<unknown>> {
  const dir = mkdtempSync(join(import.meta.dir, ".tmp-shell-e2e-"))
  dirs.push(dir)
  const file = join(dir, "stub.mjs")
  writeFileSync(file, generateServerFnStub("export const add = serverFn({}, () => 1)", "todos"))
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the stub module exports exactly the one function this test generates.
  const mod = (await import(file)) as { add(input: unknown): Promise<unknown> }
  return mod.add
}

test("the stub of a server function calls the real server from the shell and gets its answer", async () => {
  const base = fnServer([SHELL])
  Reflect.set(
    globalThis,
    SLOT,
    serverFetch({ origin: base, headers: { origin: SHELL, "content-type": "application/json" } }),
  )
  const add = await stubbedAdd()
  expect(await add({ text: "milk" })).toEqual({ added: "milk" })
  expect(SERVER_FN_PREFIX).toBe("/_nifra/fn")
})

test("the same call is refused when the server does not list the shell", async () => {
  const base = fnServer([])
  Reflect.set(
    globalThis,
    SLOT,
    serverFetch({ origin: base, headers: { origin: SHELL, "content-type": "application/json" } }),
  )
  const add = await stubbedAdd()
  await expect(add({ text: "milk" })).rejects.toThrow()
})

const TMP_BASE = `${import.meta.dir}/.tmp-shell-vite-`

function scaffold(): { root: string; routesDir: string } {
  const root = mkdtempSync(TMP_BASE)
  dirs.push(root)
  mkdirSync(join(root, "routes"), { recursive: true })
  mkdirSync(join(root, "frontend"), { recursive: true })
  mkdirSync(join(root, "frontend"), { recursive: true })
  writeFileSync(join(root, "routes/index.tsx"), "export default function Index() { return null }\n")
  writeFileSync(join(root, "frontend/client-stub.ts"), "export function mountRouter() {}\n")
  writeFileSync(
    join(root, "frontend/transport.ts"),
    'export default Object.assign(() => Promise.resolve(new Response("x")), { origin: "https://shell-marker.example" })\n',
  )
  return { root, routesDir: join(root, "routes") }
}

test("a Vite client build with a transport bundles it and installs it before the router starts", async () => {
  const { root, routesDir } = scaffold()
  const manifest = await buildClientVite({
    root,
    routesDir,
    outDir: join(root, "dist", "assets"),
    clientModule: join(root, "frontend/client-stub.ts"),
    transport: join(root, "frontend/transport.ts"),
    minify: false,
  })
  const outDir = join(root, "dist", "assets")
  const text = readdirSync(outDir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(outDir, f), "utf8"))
    .join("\n")
  expect(manifest.entry).toMatch(/\.js$/)
  expect(text).toContain("shell-marker.example")
  expect(text).toContain("nifra.fetch")
})

test("a Vite client build without a transport carries no trace of one", async () => {
  const { root, routesDir } = scaffold()
  await buildClientVite({
    root,
    routesDir,
    outDir: join(root, "dist", "assets"),
    clientModule: join(root, "frontend/client-stub.ts"),
    minify: false,
  })
  const outDir = join(root, "dist", "assets")
  const text = readdirSync(outDir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(join(outDir, f), "utf8"))
    .join("\n")
  expect(text).not.toContain("shell-marker.example")
  expect(text).not.toContain("nifra.fetch")
})
