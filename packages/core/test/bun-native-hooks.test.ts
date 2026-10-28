import { describe, expect, test } from "bun:test"
import { NIFRA_DEADLINE_HEADER } from "../src/budget.ts"
import { server } from "../src/index.ts"

/**
 * An app whose `onRequest` hooks may rewrite or answer a request still serves its routes from Bun's
 * route table: the hooks run first, and the route the table matched runs unless a hook replaced the
 * request. These tests hold that lane to the portable dispatcher's answer for every outcome a hook
 * can have.
 */

type NativeHandler = () => Response
type NativeTable = Record<string, Record<string, NativeHandler>> | undefined

function nativeKeys(app: object): string[] {
  const portable: NativeHandler = () => new Response(null)
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the table builder is private; the test lists what it holds.
  const builder = app as {
    buildBunNativeRoutes(
      fallback: NativeHandler,
      peer: object,
      platformFor: () => object,
    ): NativeTable
  }
  const table = builder.buildBunNativeRoutes(portable, {}, () => ({})) ?? {}
  return Object.keys(table)
    .flatMap((path) =>
      Object.keys(table[path]!)
        .filter((method) => table[path]![method] !== portable)
        .map((method) => `${method} ${path}`),
    )
    .sort()
}

interface Served {
  listen(
    port: number,
    options: { readonly hostname: string },
  ): { readonly port: number; stop(closeActiveConnections?: boolean): void }
  fetch(request: Request): Response | Promise<Response>
}

type Probe = readonly [method: string, path: string, init?: RequestInit]

async function show(label: string, response: Response): Promise<string> {
  const body = label.startsWith("HEAD") ? "" : await response.text()
  return `${label} -> ${response.status} after=${response.headers.get("x-after")} ${body}`
}

/** Each probe answered by `listen()` and by `app.fetch`, the second lane the portable dispatcher. */
async function lanes(
  app: Served,
  probes: readonly Probe[],
): Promise<{ listened: string[]; fetched: string[] }> {
  const instance = app.listen(0, { hostname: "127.0.0.1" })
  try {
    const listened: string[] = []
    for (const [method, path, init] of probes) {
      const response = await fetch(`http://127.0.0.1:${instance.port}${path}`, { ...init, method })
      listened.push(await show(`${method} ${path}`, response))
    }
    const fetched: string[] = []
    for (const [method, path, init] of probes) {
      const response = await app.fetch(new Request(`http://x${path}`, { ...init, method }))
      fetched.push(await show(`${method} ${path}`, response))
    }
    return { listened, fetched }
  } finally {
    instance.stop(true)
  }
}

function hooked() {
  const calls: string[] = []
  const app = server()
    .onRequest((req) => {
      const url = new URL(req.url)
      calls.push(`${req.method} ${url.pathname}`)
      return undefined
    })
    .onRequest((req) => {
      const url = new URL(req.url)
      if (url.pathname === "/blocked") return new Response("blocked", { status: 403 })
      if (url.pathname === "/rewrite") return new Request(new URL("/users/99", req.url), req)
      if (url.pathname === "/to-post") {
        return new Request(new URL("/users", req.url), { method: "POST", body: '{"name":"Zed"}' })
      }
      if (url.pathname === "/boom") throw new Error("hook failed")
      return undefined
    })
    .onRequest(async (req) => {
      const url = new URL(req.url)
      if (url.pathname === "/slow") {
        await Promise.resolve()
        return new Response("slow", { status: 202 })
      }
      if (url.pathname === "/slow-rewrite") {
        await Promise.resolve()
        return new Request(new URL("/users/55", req.url), req)
      }
      return undefined
    })
    .onResponse((response) => {
      response.headers.set("x-after", "yes")
      return response
    })
    .get("/users/:id", (c) => ({ id: c.params.id }))
    .get("/static", () => ({ ok: true }))
    .post("/users", async (c) => ({ created: (await c.req.json()).name }))
  return { app, calls }
}

const PROBES: readonly Probe[] = [
  ["GET", "/users/7"],
  ["GET", "/static"],
  ["POST", "/users", { body: '{"name":"Ada"}', headers: { "content-type": "application/json" } }],
  ["HEAD", "/users/7"],
  ["GET", "/blocked"],
  ["GET", "/rewrite"],
  ["GET", "/to-post"],
  ["GET", "/slow"],
  ["GET", "/slow-rewrite"],
  ["GET", "/boom"],
  ["GET", "/users/%ff"],
  ["GET", "/nope"],
  ["DELETE", "/users/7"],
]

describe("the route table beside onRequest hooks", () => {
  test("routes stay in the table", () => {
    const { app } = hooked()
    expect(nativeKeys(app)).toEqual([
      "GET /static",
      "GET /users/:id",
      "HEAD /static",
      "HEAD /users/:id",
      "POST /users",
    ])
  })

  test("every outcome a hook can have answers as the dispatcher answers it", async () => {
    const { app } = hooked()
    const { listened, fetched } = await lanes(app, PROBES)
    expect(listened).toEqual(fetched)
    expect(listened[0]).toContain('-> 200 after=yes {"id":"7"}')
    expect(listened[4]).toContain("-> 403 after=yes blocked")
    expect(listened[5]).toContain('{"id":"99"}')
    expect(listened[6]).toContain('{"created":"Zed"}')
    expect(listened[7]).toContain("-> 202 after=yes slow")
    expect(listened[8]).toContain('{"id":"55"}')
    expect(listened[9]).toContain("-> 500")
  })

  test("each hook runs once per request on each lane", async () => {
    const { app, calls } = hooked()
    await lanes(app, PROBES)
    const half = calls.length / 2
    expect(calls.slice(0, half)).toEqual(calls.slice(half))
    // The request a rewriting hook builds is never offered to the earlier hooks again.
    expect(calls.slice(0, half).filter((call) => call.endsWith("/rewrite"))).toHaveLength(1)
    expect(calls.slice(0, half)).toHaveLength(PROBES.length)
  })

  test("a hook that names the caller sees the socket peer", async () => {
    const seen: (string | undefined)[] = []
    const app = server()
      .onRequest((_req, platform) => {
        seen.push(platform?.clientIp)
        return undefined
      })
      .get("/users/:id", (c) => ({ ip: c.clientIp ?? null }))
    expect(nativeKeys(app)).toContain("GET /users/:id")
    const instance = app.listen(0, { hostname: "127.0.0.1" })
    try {
      const response = await fetch(`http://127.0.0.1:${instance.port}/users/7`)
      expect(await response.json()).toEqual({ ip: "127.0.0.1" })
    } finally {
      instance.stop(true)
    }
    expect(seen).toEqual(["127.0.0.1"])
  })

  test("a hook sees the caller a clientIp trust declaration names", async () => {
    const seen: (string | undefined)[] = []
    const app = server({ clientIp: { trustedHops: 1 } })
      .onRequest((_req, platform) => {
        seen.push(platform?.clientIp)
        return undefined
      })
      .get("/users/:id", (c) => ({ ip: c.clientIp ?? null }))
    const instance = app.listen(0, { hostname: "127.0.0.1" })
    try {
      const response = await fetch(`http://127.0.0.1:${instance.port}/users/7`, {
        headers: { "x-forwarded-for": "9.9.9.9, 8.8.8.8" },
      })
      expect(await response.json()).toEqual({ ip: "8.8.8.8" })
    } finally {
      instance.stop(true)
    }
    expect(seen).toEqual(["8.8.8.8"])
  })

  test("a hook that reads the body leaves it to the route", async () => {
    const app = server()
      .onRequest(async (req) => {
        const copy = await req.clone().json()
        return copy.name === "deny" ? new Response("denied", { status: 403 }) : undefined
      })
      .post("/users", async (c) => ({ created: (await c.req.json()).name }))
    const { listened, fetched } = await lanes(app, [
      ["POST", "/users", { body: '{"name":"Ada"}' }],
      ["POST", "/users", { body: '{"name":"deny"}' }],
    ])
    expect(listened).toEqual(fetched)
    expect(listened[0]).toContain('{"created":"Ada"}')
    expect(listened[1]).toContain("-> 403")
  })

  test("an inbound deadline and a request timeout apply to the route after the hooks", async () => {
    const routes = <App extends ReturnType<typeof server>>(app: App) =>
      app
        .onRequest(() => undefined)
        .get("/users/:id", (c) => ({ id: c.params.id }))
        .get("/static", () => ({ ok: true }))
    const live = { headers: { [NIFRA_DEADLINE_HEADER]: String(Date.now() + 60_000) } }
    const spent = { headers: { [NIFRA_DEADLINE_HEADER]: String(Date.now() - 1_000) } }
    const apps = [
      routes(server({ acceptInboundDeadlines: true })),
      routes(server({ requestTimeoutMs: 5_000 })),
    ]
    for (const app of apps) {
      expect(nativeKeys(app)).toContain("GET /users/:id")
      const { listened, fetched } = await lanes(app, [
        ["GET", "/users/7"],
        ["GET", "/users/7", live],
        ["GET", "/static", spent],
      ])
      expect(listened).toEqual(fetched)
      expect(listened[0]).toContain('-> 200 after=null {"id":"7"}')
    }
  })
})
