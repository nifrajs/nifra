import { describe, expect, test } from "bun:test"
import { server, silentLogger } from "../src/index.ts"
import { websocket } from "../src/ws.ts"

type NativeTable = Record<string, Record<string, unknown>> | undefined

/** The routes Bun's own table holds, as `METHOD /path`. */
function tableKeys(app: object): string[] {
  const portable = () => new Response(null)
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: buildBunNativeRoutes is the private method listen() builds Bun's table with; it reads only the app.
  const routes = app as { buildBunNativeRoutes(fallback: () => Response): NativeTable }
  return Object.entries(routes.buildBunNativeRoutes(portable) ?? {})
    .flatMap(([path, methods]) =>
      Object.entries(methods)
        .filter(([, handler]) => handler !== portable)
        .map(([method]) => `${method} ${path}`),
    )
    .sort()
}

/** A static handler that answers `/robots.txt` and records every request it sees. */
function robots(): {
  readonly seen: string[]
  readonly static: (request: Request) => Response | undefined
} {
  const seen: string[] = []
  return {
    seen,
    static(request) {
      const { pathname } = new URL(request.url)
      seen.push(`${request.method} ${pathname}`)
      return pathname === "/robots.txt" ? new Response("file") : undefined
    },
  }
}

type Listening = { listen(port: number, options: object): { readonly port: number } }

async function answers(
  app: Listening & { stop(options: { drainMs: number }): Promise<unknown> },
  options: object,
  requests: readonly (readonly [path: string, init?: RequestInit])[],
): Promise<string[]> {
  const running = app.listen(0, { hostname: "127.0.0.1", ...options })
  const out: string[] = []
  try {
    for (const [path, init] of requests) {
      const response = await fetch(`http://127.0.0.1:${running.port}${path}`, init)
      out.push(`${response.status} ${await response.text()}`)
    }
  } finally {
    await app.stop({ drainMs: 0 })
  }
  return out
}

describe("listen({ static })", () => {
  test("a file it answers wins over a route Bun's table serves at the same path", async () => {
    const app = server().get("/:slug", (c) => ({ slug: c.params.slug }))
    expect(tableKeys(app)).toContain("GET /:slug")
    const files = robots()
    expect(
      await answers(app, { static: files.static }, [
        ["/robots.txt"],
        ["/about"],
        ["/robots.txt", { method: "HEAD" }],
      ]),
    ).toEqual(["200 file", '200 {"slug":"about"}', "200 "])
    expect(files.seen).toEqual(["GET /robots.txt", "GET /about", "HEAD /robots.txt"])
  })

  test("undefined, returned or resolved, hands the request to the app", async () => {
    const app = server().get("/:slug", (c) => ({ slug: c.params.slug }))
    const front = (request: Request) => {
      const { pathname } = new URL(request.url)
      if (pathname === "/later") return Promise.resolve(new Response("file later"))
      if (pathname === "/pending") return Promise.resolve(undefined)
      return undefined
    }
    expect(await answers(app, { static: front }, [["/later"], ["/pending"], ["/now"]])).toEqual([
      "200 file later",
      '200 {"slug":"pending"}',
      '200 {"slug":"now"}',
    ])
  })

  test("it fronts the portable dispatcher, and no app hook sees a request it answers", async () => {
    const hooked: string[] = []
    const app = server()
      .onRequest((request) => {
        hooked.push(`request ${new URL(request.url).pathname}`)
      })
      .onResponse((response, request) => {
        hooked.push(`response ${new URL(request.url).pathname}`)
        return response
      })
      .get("/:slug", (c) => ({ slug: c.params.slug }))
    expect(tableKeys(app)).toEqual([])
    const files = robots()
    expect(await answers(app, { static: files.static }, [["/robots.txt"], ["/about"]])).toEqual([
      "200 file",
      '200 {"slug":"about"}',
    ])
    expect(hooked).toEqual(["request /about", "response /about"])
  })

  test("it fronts an app with WebSocket routes", async () => {
    const app = server()
      .use(websocket())
      .ws("/sock", { message: () => {} })
      .get("/:slug", (c) => ({ slug: c.params.slug }))
    const files = robots()
    expect(await answers(app, { static: files.static }, [["/robots.txt"], ["/about"]])).toEqual([
      "200 file",
      '200 {"slug":"about"}',
    ])
  })

  test("a throw answers the listener's plain 500, not Bun's development page", async () => {
    const app = server({ logger: silentLogger }).get("/:slug", (c) => ({ slug: c.params.slug }))
    const front = (request: Request) => {
      if (new URL(request.url).pathname === "/sync") throw new Error("disk gone")
      if (new URL(request.url).pathname === "/async") return Promise.reject(new Error("disk gone"))
      return undefined
    }
    expect(await answers(app, { static: front }, [["/sync"], ["/async"]])).toEqual([
      '500 {"ok":false,"error":"internal_error"}',
      '500 {"ok":false,"error":"internal_error"}',
    ])
  })
})
