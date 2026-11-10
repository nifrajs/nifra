import { expect, test } from "bun:test"
import ts from "typescript"
import { buildManifest, generateClientEntry, type RouteModule } from "../src/index.ts"
import { createClientRouter, type RouterFetch } from "../src/router.ts"
import { serverFetch } from "../src/server-fetch.ts"

const patterns = [
  { routeId: "home", pattern: "/" },
  { routeId: "todos", pattern: "/todos" },
]
const initial = { routeId: "home", params: {}, path: "/", data: {}, pending: false } as const

/** Run `body` with the global `fetch` replaced by a recorder that answers a data envelope. */
async function withGlobalFetch(body: (global: string[]) => Promise<void>): Promise<void> {
  const real = globalThis.fetch
  const seen: string[] = []
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a test double; the router only calls fetch, never its static members.
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    seen.push(`${init?.method ?? "GET"} ${String(input)}`)
    return Response.json({ rows: [] })
  }) as typeof fetch
  try {
    await body(seen)
  } finally {
    globalThis.fetch = real
  }
}

test("a router given a fetch sends route data, prefetches and action posts through it, not the global", async () => {
  await withGlobalFetch(async (global) => {
    const sent: string[] = []
    const send: RouterFetch = async (input, init) => {
      sent.push(`${init?.method ?? "GET"} ${input}`)
      return Response.json({ rows: [] })
    }
    const router = createClientRouter({
      patterns,
      initial,
      loadModule: async () => {},
      fetch: send,
    })
    await router.navigate("/todos")
    await router.prefetch("/todos?x=1")
    const form = new FormData()
    form.set("title", "milk")
    await router.submit("/todos", form).catch(() => {})
    expect(sent.slice(0, 2)).toEqual(["GET /todos", "GET /todos?x=1"])
    expect(sent).toContain("POST /todos")
    expect(global).toEqual([])
  })
})

test("a router without a fetch keeps using the global one", async () => {
  await withGlobalFetch(async (global) => {
    const router = createClientRouter({ patterns, initial, loadModule: async () => {} })
    await router.navigate("/todos")
    expect(global).toEqual(["GET /todos"])
  })
})

test("serverFetch sends a path-absolute URL to the origin and leaves anything else alone", async () => {
  const sent: string[] = []
  const send: RouterFetch = async (input) => {
    sent.push(input)
    return new Response(null)
  }
  const go = serverFetch({ origin: "https://api.example.com/", fetch: send })
  await go("/todos?page=2")
  await go("//evil.example/x")
  await go("https://other.example/y")
  await go("relative")
  expect(sent).toEqual([
    "https://api.example.com/todos?page=2",
    // Still the origin's own path: a protocol-relative URL cannot move the request to another host.
    "https://api.example.com//evil.example/x",
    "https://other.example/y",
    "relative",
  ])
})

test("serverFetch adds its headers over the request's, awaits a header function, and sets credentials", async () => {
  const seen: { headers: Headers; credentials: RequestCredentials | undefined }[] = []
  const send: RouterFetch = async (_input, init) => {
    seen.push({ headers: new Headers(init?.headers), credentials: init?.credentials })
    return new Response(null)
  }
  let token = "t1"
  const go = serverFetch({
    origin: "https://api.example.com",
    headers: async () => ({ authorization: `Bearer ${token}` }),
    credentials: "include",
    fetch: send,
  })
  await go("/a", { headers: { "x-nifra-data": "1", authorization: "Bearer stale" } })
  token = "t2"
  await go("/b")
  expect(seen[0]?.headers.get("x-nifra-data")).toBe("1")
  expect(seen[0]?.headers.get("authorization")).toBe("Bearer t1")
  expect(seen[1]?.headers.get("authorization")).toBe("Bearer t2")
  expect(seen[0]?.credentials).toBe("include")

  const plain: RouterFetch = async (_input, init) => {
    seen.push({ headers: new Headers(init?.headers), credentials: init?.credentials })
    return new Response(null)
  }
  await serverFetch({ origin: "https://x.example", fetch: plain })("/c")
  expect(seen[2]?.credentials).toBeUndefined()
})

test("serverFetch keeps its headers and credentials for the server's origin and sends no other host the bearer token", async () => {
  const seen: { url: string; auth: string | null; credentials: RequestCredentials | undefined }[] =
    []
  const send: RouterFetch = async (input, init) => {
    seen.push({
      url: input,
      auth: new Headers(init?.headers).get("authorization"),
      credentials: init?.credentials,
    })
    return new Response(null)
  }
  const go = serverFetch({
    origin: "https://api.example.com",
    headers: { authorization: "Bearer secret" },
    credentials: "include",
    fetch: send,
  })
  await go("/mine")
  await go("https://api.example.com/absolute")
  await go("https://api.example.com?q=1")
  await go("https://third-party.example/x")
  await go("https://api.example.com.evil.example/x")
  await go("https://api.example.community/x")
  expect(seen.map((s) => [s.url, s.auth, s.credentials])).toEqual([
    ["https://api.example.com/mine", "Bearer secret", "include"],
    ["https://api.example.com/absolute", "Bearer secret", "include"],
    ["https://api.example.com?q=1", "Bearer secret", "include"],
    ["https://third-party.example/x", null, undefined],
    ["https://api.example.com.evil.example/x", null, undefined],
    ["https://api.example.community/x", null, undefined],
  ])
})

const importer = (file: string) => async (): Promise<RouteModule> => ({ default: file })
const FILES = ["_layout.tsx", "index.tsx", "list.tsx"]
const base = { clientModule: "@nifrajs/web-react/client", resolve: (f: string) => `/routes/${f}` }
const parses = (code: string): boolean =>
  ts.transpileModule(code, {
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext },
  }).diagnostics?.length === 0

test("a transport entry imports the module and gives the router its fetch; one without carries no trace", () => {
  const manifest = buildManifest(FILES, importer)
  const plain = generateClientEntry(manifest, base)
  expect(plain).not.toContain("__transport")
  const code = generateClientEntry(manifest, { ...base, transport: "/app/shell/transport.ts" })
  expect(code).toContain('import __transport from "/app/shell/transport.ts"')
  expect(code).toContain("routeHooks, fetch: __transport })")
  expect(parses(code)).toBe(true)
})

test("a transport and keep-alive entry layers keep-alive over the transport's route data", () => {
  const manifest = buildManifest(FILES, importer, { keepAlive: ["list.tsx"] })
  const code = generateClientEntry(manifest, { ...base, transport: "t.ts" })
  expect(code).toContain("routeDataTransport")
  expect(code).toContain("fetchData: routeDataTransport(__transport)")
  expect(parses(code)).toBe(true)
})

test("a transport entry beside a live server and keep-alive still parses", () => {
  const manifest = buildManifest(FILES, importer, { keepAlive: ["list.tsx"] })
  const code = generateClientEntry(manifest, {
    ...base,
    transport: "/app/shell/transport.ts",
    live: { path: "/rt" },
  })
  expect(parses(code)).toBe(true)
})
