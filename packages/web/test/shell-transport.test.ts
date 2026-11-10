/**
 * The rest of the native-shell transport: what app code, server functions, the live socket, keep-alive,
 * the dev servers and a deep link do once a build has a `transport`.
 */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { server } from "@nifrajs/core"
import { t } from "@nifrajs/schema"
import { writeDevFiles } from "../src/dev.ts"
import { SERVER_FN_PREFIX, serverFn, serverFunctions } from "../src/fn.ts"
import { buildManifest, generateClientEntry, type RouteModule } from "../src/index.ts"
import { generateServerFnStub } from "../src/internal/server-boundary.ts"
import { keepAliveClient } from "../src/keep-alive.ts"
import { liveClient } from "../src/live-client.ts"
import { appFetch, routeDataTransport, serverFetch } from "../src/server-fetch.ts"

const SLOT = Symbol.for("nifra.fetch")
const slot = (value: unknown): void => {
  Reflect.set(globalThis, SLOT, value)
}

const realFetch = globalThis.fetch
afterEach(() => {
  Reflect.deleteProperty(globalThis, SLOT)
  globalThis.fetch = realFetch
})

test("appFetch goes through the installed transport, and through the global fetch without one", async () => {
  const global: string[] = []
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a test double; appFetch only calls fetch, never its static members.
  globalThis.fetch = (async (input: string | URL) => {
    global.push(String(input))
    return new Response(null)
  }) as typeof fetch
  await appFetch("/a")
  const sent: string[] = []
  slot(async (input: string) => {
    sent.push(input)
    return new Response(null)
  })
  await appFetch("/b")
  expect(global).toEqual(["/a"])
  expect(sent).toEqual(["/b"])
})

test("the typed client's calls and a useQuery fetcher reach the server through serverFetch", async () => {
  const seen: { url: string; auth: string | null }[] = []
  const inner = async (input: string, init?: RequestInit): Promise<Response> => {
    seen.push({ url: input, auth: new Headers(init?.headers).get("authorization") })
    return Response.json({ ok: true })
  }
  slot(
    serverFetch({
      origin: "https://api.example.com",
      headers: { authorization: "Bearer t" },
      fetch: inner,
    }),
  )
  const { client } = await import("@nifrajs/client")
  const api = client<never>("", { fetch: appFetch })
  // A path-absolute URL is what a same-origin page's client calls, and what the transport redirects.
  // biome-ignore lint/plugin/noChainedTypeAssertions: the client is typed by the app's contract; this test has none and only needs the proxy's call shape.
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: same reason, a test double for the typed client.
  await (api as unknown as { todos: { get(): Promise<unknown> } }).todos.get()
  await appFetch("/", { headers: { "x-nifra-data": "1" } })
  expect(seen.map((s) => s.url)).toEqual([
    "https://api.example.com/todos",
    "https://api.example.com/",
  ])
  expect(seen.every((s) => s.auth === "Bearer t")).toBe(true)
})

test("a server function stub calls through the installed transport and falls back to fetch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nifra-stub-"))
  try {
    const file = join(dir, "stub.mjs")
    writeFileSync(file, generateServerFnStub("export const add = serverFn({}, () => 1)", "todos"))
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the stub module exports exactly the one function this test generates.
    const { add } = (await import(file)) as { add(input: unknown): Promise<unknown> }
    const sent: { url: string; credentials: RequestCredentials | undefined }[] = []
    slot(async (input: string, init?: RequestInit) => {
      sent.push({ url: input, credentials: init?.credentials })
      return Response.json({ ok: 1 })
    })
    expect(await add({ text: "x" })).toEqual({ ok: 1 })
    expect(sent).toEqual([{ url: "/_nifra/fn/todos/add", credentials: "same-origin" }])
    Reflect.deleteProperty(globalThis, SLOT)
    const global: string[] = []
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a test double; the stub only calls fetch.
    globalThis.fetch = (async (input: string | URL) => {
      global.push(String(input))
      return Response.json({ ok: 2 })
    }) as typeof fetch
    expect(await add({})).toEqual({ ok: 2 })
    expect(global).toEqual(["/_nifra/fn/todos/add"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const fns = { ping: serverFn({ output: t.object({ pong: t.boolean() }) }, () => ({ pong: true })) }
const call = (app: ReturnType<typeof server>, origin: string): Promise<Response> =>
  Promise.resolve(
    app.fetch(
      new Request(`http://t${SERVER_FN_PREFIX}/todos/ping`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: "{}",
      }),
    ),
  )

test("serverFunctions refuses another origin unless `origins` lists it", async () => {
  const plain = server().use(serverFunctions("todos", fns))
  expect((await call(plain, "tauri://localhost")).status).toBe(403)
  const listed = server().use(
    serverFunctions("todos", fns, { origins: ["tauri://localhost", "capacitor://localhost"] }),
  )
  expect((await call(listed, "tauri://localhost")).status).toBe(200)
  expect((await call(listed, "capacitor://localhost")).status).toBe(200)
  expect((await call(listed, "https://evil.example")).status).toBe(403)
  expect((await call(listed, "http://t")).status).toBe(200)
  const decided = server().use(
    serverFunctions("todos", fns, { origins: (origin) => origin.endsWith(".shell.example") }),
  )
  expect((await call(decided, "https://app.shell.example")).status).toBe(200)
  expect((await call(decided, "https://shell.example.evil")).status).toBe(403)
})

class FakeSocket {
  static all: FakeSocket[] = []
  readyState = 0
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }
  send(): void {}
  close(): void {}
}
const savedSocket = Reflect.get(globalThis, "WebSocket")
beforeEach(() => {
  FakeSocket.all = []
  Reflect.set(globalThis, "WebSocket", FakeSocket)
})
afterEach(() => {
  Reflect.set(globalThis, "WebSocket", savedSocket)
})

test("the live socket connects to the origin it is given, and to the page's own without one", async () => {
  Reflect.set(globalThis, "location", { origin: "tauri://localhost", href: "tauri://localhost/" })
  try {
    const remote = liveClient({ origin: "https://api.example.com", path: "/rt" })
    const router = fakeRouter()
    const stop = remote.attach(router)
    await Promise.resolve()
    stop()
    expect(FakeSocket.all.map((s) => s.url)).toEqual(["wss://api.example.com/rt"])
    Reflect.set(globalThis, "location", {
      origin: "https://page.example",
      href: "https://page.example/x",
    })
    const own = liveClient({ path: "/rt" }).attach(fakeRouter())
    await Promise.resolve()
    own()
    expect(FakeSocket.all.at(-1)?.url).toBe("wss://page.example/rt")
  } finally {
    Reflect.deleteProperty(globalThis, "location")
  }
})

const fakeRouter = (): Parameters<ReturnType<typeof liveClient>["attach"]>[0] =>
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a router stand-in; the live client only subscribes and reads a snapshot here.
  ({
    snapshot: () => ({ routeId: "index", params: {}, path: "/", data: {}, pending: false }),
    subscribe: () => () => {},
    invalidate: async () => {},
  }) as never

test("keep-alive's route data goes through the transport it is layered over", async () => {
  const sent: string[] = []
  const keep = keepAliveClient({
    table: { routes: [], layouts: [] },
    routeHooks: {},
    matchChains: {},
    fetchData: routeDataTransport(async (input) => {
      sent.push(input)
      return Response.json({ rows: [] })
    }),
  })
  await keep.fetchData("/todos", { routeId: "todos", params: {} })
  expect(sent).toEqual(["/todos"])
})

const importer = (file: string) => async (): Promise<RouteModule> => ({ default: file })
const base = { clientModule: "@nifrajs/web-react/client", resolve: (f: string) => `/routes/${f}` }
const FILES = ["_layout.tsx", "index.tsx", "todos.tsx"]

test("a transport entry installs the transport in the global slot before anything calls it", () => {
  const code = generateClientEntry(buildManifest(FILES, importer), {
    ...base,
    transport: "/app/t.ts",
  })
  const install = code.indexOf('globalThis[Symbol.for("nifra.fetch")] = __transport')
  expect(install).toBeGreaterThan(code.indexOf("import __transport"))
  expect(install).toBeLessThan(code.indexOf("const patterns"))
})

test("a transport entry with a live server gives the live client the transport and its origin", () => {
  const manifest = buildManifest(FILES, importer)
  const code = generateClientEntry(manifest, {
    ...base,
    transport: "/app/t.ts",
    live: { path: "/rt", loadPath: "/rt/load" },
  })
  expect(code).toContain(
    'liveClient({ layoutIdsOf, path: "/rt", loadPath: "/rt/load", fetch: __transport, origin: __transport.origin })',
  )
  expect(code).toContain("routeHooks, fetchData: __live.fetchData, fetch: __transport })")
})

test("a transport entry with keep-alive sends actions through the transport too", () => {
  const manifest = buildManifest(FILES, importer, { keepAlive: ["todos.tsx"] })
  const code = generateClientEntry(manifest, { ...base, transport: "/app/t.ts" })
  expect(code).toContain("routeHooks, fetchData: __keep.fetchData, fetch: __transport })")
})

test("a transport entry hydrates the document it ships, then goes to a URL that document is not", () => {
  const code = generateClientEntry(buildManifest(FILES, importer), {
    ...base,
    transport: "/app/t.ts",
  })
  expect(code).toContain(
    'const detour = !!matched && !terminal && serverRoute !== "" && matched.routeId !== serverRoute',
  )
  expect(code).toContain(
    "routeId: matched && !terminal && !detour ? matched.routeId : serverRoute,",
  )
  expect(code).toContain("path: detour ? shippedPath : location.pathname + location.search,")
  expect(code).toContain("if (detour) router.navigate(target).then(")
  // The router is given the path and query, never the fragment, which is put back afterwards.
  expect(code).toContain("const target = location.pathname + location.search\n")
  expect(code).toContain("const fragment = location.hash")
  expect(code).toContain('history.replaceState(history.state, "", target + fragment)')
  // An entry without a transport is exactly the entry it was: none of the above.
  const plain = generateClientEntry(buildManifest(FILES, importer), base)
  for (const token of ["detour", "shippedPath", "__transport", "nifra.fetch"]) {
    expect(plain).not.toContain(token)
  }
})

test("a dev entry imports the transport relative to the entry file", () => {
  const root = mkdtempSync(join(tmpdir(), "nifra-dev-transport-"))
  try {
    const routesDir = `${root}/routes`
    mkdirSync(routesDir, { recursive: true })
    writeFileSync(`${routesDir}/index.tsx`, "export default function Index() { return null }\n")
    writeDevFiles({
      routesDir,
      clientModule: "@nifrajs/web-react/client",
      entryPath: `${root}/.nifra-bun/entry.tsx`,
      htmlPath: `${root}/.nifra-bun/entry.html`,
      transport: `${root}/shell/transport.ts`,
    })
    const entry = readFileSync(`${root}/.nifra-bun/entry.tsx`, "utf8")
    expect(entry).toContain('import __transport from "../shell/transport.ts"')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
