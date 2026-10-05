import { describe, expect, test } from "bun:test"
import { NIFRA_DEADLINE_HEADER } from "../src/budget.ts"
import { idempotency } from "../src/idempotency-plugin.ts"
import { server } from "../src/index.ts"

/**
 * `listen()` on Bun hands some routes to Bun's own route table and the rest to the portable
 * dispatcher. These tests hold `c.clientIp` to one answer on both: the socket peer.
 */

/** The part of a server these tests drive. */
interface Served {
  listen(
    port: number,
    options: { readonly hostname: string },
  ): { readonly port: number; stop(closeActiveConnections?: boolean): void }
}
type NativeHandler = () => Response
type NativeTable = Record<string, Record<string, NativeHandler>> | undefined

/** The routes served from Bun's table, as `METHOD /path`, without the portable dispatcher entries. */
function nativeKeys(app: object): string[] {
  const portable: NativeHandler = () => new Response(null)
  const table =
    (app as { buildBunNativeRoutes(fallback: NativeHandler): NativeTable }).buildBunNativeRoutes(
      portable,
    ) ?? {}
  return Object.keys(table)
    .flatMap((path) =>
      Object.keys(table[path]!)
        .filter((method) => table[path]![method] !== portable)
        .map((method) => `${method} ${path}`),
    )
    .sort()
}

/** Each request's status and body, from a server bound to the loopback address itself. */
async function served(
  app: Served,
  requests: readonly (readonly [path: string, init?: RequestInit])[],
): Promise<string[]> {
  const instance = app.listen(0, { hostname: "127.0.0.1" })
  const out: string[] = []
  try {
    for (const [path, init] of requests) {
      const response = await fetch(`http://127.0.0.1:${instance.port}${path}`, init)
      out.push(`${response.status} ${await response.text()}`)
    }
  } finally {
    instance.stop(true)
  }
  return out
}

const PEER = '200 {"ip":"127.0.0.1"}'

describe("c.clientIp under Bun listen()", () => {
  test("a route in Bun's table and a route outside it name the same peer", async () => {
    const app = server()
      .get("/static", (c) => ({ ip: c.clientIp }))
      .get("/users/:id", (c) => ({ ip: c.clientIp }))
      .post("/users/:id", async (c) => {
        await c.req.text()
        return { ip: c.clientIp }
      })
      .get("/files/*rest", (c) => ({ ip: c.clientIp }))
    expect(nativeKeys(app)).toEqual([
      "GET /static",
      "GET /users/:id",
      "HEAD /static",
      "HEAD /users/:id",
      "POST /users/:id",
    ])
    expect(
      await served(app, [
        ["/static"],
        ["/users/7"],
        ["/users/7", { method: "POST", body: "x" }],
        ["/files/a/b"],
      ]),
    ).toEqual([PEER, PEER, PEER, PEER])
  })

  test("a request with no socket behind it has no peer", async () => {
    const app = server()
      .get("/static", (c) => ({ ip: c.clientIp ?? null }))
      .get("/users/:id", (c) => ({ ip: c.clientIp ?? null }))
    for (const path of ["/static", "/users/7"]) {
      const response = await app.fetch(new Request(`http://x${path}`))
      expect(await response.json()).toEqual({ ip: null })
    }
  })

  test("the peer is named on the table's other lanes too", async () => {
    const routes = <App extends ReturnType<typeof server>>(app: App) =>
      app.get("/static", (c) => ({ ip: c.clientIp })).get("/users/:id", (c) => ({ ip: c.clientIp }))
    const deadline = { headers: { [NIFRA_DEADLINE_HEADER]: String(Date.now() + 60_000) } }

    const timed = routes(server({ requestTimeoutMs: 5_000 }))
    expect(nativeKeys(timed)).toContain("GET /users/:id")
    expect(await served(timed, [["/static"], ["/users/7"]])).toEqual([PEER, PEER])

    const deadlines = routes(server({ acceptInboundDeadlines: true }))
    expect(nativeKeys(deadlines)).toContain("GET /users/:id")
    expect(
      await served(deadlines, [
        ["/static"],
        ["/users/7"],
        ["/static", deadline],
        ["/users/7", deadline],
      ]),
    ).toEqual([PEER, PEER, PEER, PEER])
  })

  test("a parameter that is not valid UTF-8 is refused on every lane of the table", async () => {
    const routes = <App extends ReturnType<typeof server>>(app: App) =>
      app.get("/users/:id", (c) => ({ ip: c.clientIp }))
    for (const app of [
      routes(server()),
      routes(server({ requestTimeoutMs: 5_000 })),
      routes(server({ acceptInboundDeadlines: true })),
    ]) {
      const [bad, good] = await served(app, [["/users/%ff"], ["/users/7"]])
      expect(bad).toStartWith("400 ")
      expect(good).toBe(PEER)
    }
  })

  test("an idempotent route names the peer of the request it buffered", async () => {
    const app = server()
      .use(idempotency())
      .post("/pay", { idempotency: { scope: "request", namespace: "public:pay" } }, (c) => ({
        ip: c.clientIp,
      }))
      .get("/static", (c) => ({ ip: c.clientIp }))
    expect(nativeKeys(app)).toEqual(["GET /static", "HEAD /static"])
    expect(
      await served(app, [
        [
          "/pay",
          {
            method: "POST",
            headers: { "content-type": "application/json", "idempotency-key": "k-1" },
            body: "{}",
          },
        ],
        ["/static"],
      ]),
    ).toEqual([PEER, PEER])
  })

  test("a read after the connection closed agrees with the read before it", async () => {
    const late: (string | undefined)[] = []
    let settle!: () => void
    const reads = (): Promise<void> => new Promise<void>((resolve) => (settle = resolve))
    const handler = (c: { readonly clientIp: string | undefined }) => {
      const before = c.clientIp
      setTimeout(() => {
        late.push(c.clientIp)
        settle()
      }, 100)
      return { ip: before }
    }
    const app = server().get("/static", handler).get("/files/*rest", handler)
    const instance = app.listen(0, { hostname: "127.0.0.1" })
    try {
      for (const path of ["/static", "/files/a"]) {
        const done = reads()
        const response = await fetch(`http://127.0.0.1:${instance.port}${path}`, {
          headers: { connection: "close" },
        })
        expect(await response.json()).toEqual({ ip: "127.0.0.1" })
        await done
      }
    } finally {
      instance.stop(true)
    }
    expect(late).toEqual(["127.0.0.1", "127.0.0.1"])
  })
})
