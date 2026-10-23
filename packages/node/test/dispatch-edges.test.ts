import { afterEach, describe, expect, test } from "bun:test"
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http"
import { connect } from "node:net"
import { type FetchHandler, type NodeServer, serve } from "../src/index.ts"

const RESOLVE_NODE_MOUNT = Symbol.for("@nifrajs/core/resolve-node-mount")
const INSTALL_NODE_DIRECT = Symbol.for("@nifrajs/core/install-node-direct")

let running: NodeServer | undefined
afterEach(async () => {
  await running?.stop({ drainMs: 0 })
  running = undefined
})

interface MountRequest {
  readonly method: string
  readonly url: string
  readonly headers: IncomingHttpHeaders
  readonly raw: IncomingMessage
}

type MountHandler = (request: MountRequest, response: ServerResponse) => unknown

/** A bare handler exposing the native-mount seam: `x-mount` picks what the mount does. */
function mountedApp(
  handlers: Record<string, MountHandler>,
  rest: Record<string, unknown> = {},
): FetchHandler & Record<symbol, unknown> {
  return {
    fetch: () => new Response("web", { status: 200 }),
    ...rest,
    [RESOLVE_NODE_MOUNT](source: { header(name: string): string | null }) {
      const mode = source.header("x-mount")
      if (mode === "throw-select") throw new Error("selector crashed")
      const handler = mode === null ? undefined : handlers[mode]
      if (handler === undefined) return undefined
      return { handler, path: "/api", stripPrefix: source.header("x-strip") === "1" }
    },
  }
}

async function served(app: FetchHandler, options: Record<string, unknown> = {}): Promise<string> {
  running = await serve(app, { hostname: "127.0.0.1", port: 0, ...options })
  return `http://127.0.0.1:${running.port}`
}

const native: MountHandler = (request, response) => {
  response.writeHead(200, { "content-type": "text/plain" })
  response.end(`native ${request.method} ${request.url}`)
}

describe("native mount dispatch", () => {
  test("a selected mount writes the response, with its prefix stripped on request", async () => {
    const base = await served(mountedApp({ native }))
    const kept = await fetch(`${base}/api/users?x=1`, { headers: { "x-mount": "native" } })
    expect(await kept.text()).toBe(`native GET ${base}/api/users?x=1`)
    const stripped = await fetch(`${base}/api/users?x=1`, {
      headers: { "x-mount": "native", "x-strip": "1" },
    })
    expect(await stripped.text()).toBe(`native GET ${base}/users?x=1`)
    const root = await fetch(`${base}/api`, { headers: { "x-mount": "native", "x-strip": "1" } })
    expect(await root.text()).toBe(`native GET ${base}/`)
    const none = await fetch(`${base}/api/users`)
    expect(await none.text()).toBe("web")
  })

  test("a mount that declines, sync or async, falls through to the web lane", async () => {
    const base = await served(
      mountedApp({ declines: () => false, "declines-later": async () => false }),
    )
    for (const mode of ["declines", "declines-later"]) {
      const response = await fetch(`${base}/api/x`, { headers: { "x-mount": mode } })
      expect([response.status, await response.text()]).toEqual([200, "web"])
    }
  })

  test("a selector or mount that fails answers a bare 500", async () => {
    const base = await served(
      mountedApp({
        throws: () => {
          throw new Error("mount crashed")
        },
        rejects: async () => {
          throw new Error("mount crashed later")
        },
      }),
    )
    for (const mode of ["throw-select", "throws", "rejects"]) {
      const response = await fetch(`${base}/api/x`, { headers: { "x-mount": mode } })
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ ok: false, error: "internal_error" })
    }
  })

  test("the fallback renders through resolveNode when the app has one", async () => {
    const outcome = (body: string) => ({
      kind: "body" as const,
      status: 201,
      headers: { "content-type": "text/plain" },
      body,
    })
    const base = await served(
      mountedApp(
        { declines: () => false },
        {
          resolveNode(request: Request) {
            const path = new URL(request.url).pathname
            if (path === "/sync") return outcome("sync outcome")
            if (path === "/async") return Promise.resolve(outcome("async outcome"))
            if (path === "/throws") throw new Error("resolve crashed")
            return Promise.reject(new Error("resolve crashed later"))
          },
        },
      ),
    )
    const headers = { "x-mount": "declines" }
    for (const [path, text] of [
      ["/sync", "sync outcome"],
      ["/async", "async outcome"],
    ] as const) {
      const response = await fetch(`${base}${path}`, { headers })
      expect([response.status, await response.text()]).toEqual([201, text])
    }
    for (const path of ["/throws", "/rejects"])
      expect((await fetch(`${base}${path}`, { headers })).status).toBe(500)
  })

  test("the fallback without resolveNode calls fetch, and a failing fetch answers 500", async () => {
    const base = await served(
      mountedApp(
        { declines: () => false },
        {
          fetch(request: Request) {
            const path = new URL(request.url).pathname
            if (path === "/async") return Promise.resolve(new Response("async web"))
            if (path === "/throws") throw new Error("fetch crashed")
            if (path === "/rejects") return Promise.reject(new Error("fetch crashed later"))
            return new Response("sync web")
          },
        },
      ),
    )
    const headers = { "x-mount": "declines" }
    expect(await (await fetch(`${base}/sync`, { headers })).text()).toBe("sync web")
    expect(await (await fetch(`${base}/async`, { headers })).text()).toBe("async web")
    for (const path of ["/throws", "/rejects"])
      expect((await fetch(`${base}${path}`, { headers })).status).toBe(500)
  })

  test("an install seam that throws still serves the app", async () => {
    const app: FetchHandler & Record<symbol, unknown> = {
      fetch: () => new Response("served"),
      [INSTALL_NODE_DIRECT]() {
        throw new Error("already frozen")
      },
    }
    const base = await served(app)
    expect(await (await fetch(`${base}/`)).text()).toBe("served")
  })
})

describe("Host authority and protocol policy", () => {
  const hostOf = (port: number, host: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const socket = connect(port, "127.0.0.1")
      let received = ""
      socket.on("error", reject)
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("latin1")
      })
      socket.on("end", () => resolve(received))
      socket.write(`GET /host HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
    })
  const originApp: FetchHandler = {
    fetch: (request: Request) => new Response(new URL(request.url).host),
  }

  test("a bracketed IPv6 Host is normalized, and a malformed one is a 400", async () => {
    await served(originApp)
    const port = running?.port ?? 0
    expect(await hostOf(port, "[::1]:8080")).toEndWith("[::1]:8080")
    expect(await hostOf(port, "[ABCD::1]")).toEndWith("[abcd::1]")
    for (const host of ["[::1", "[::1]x", "[]", "[zz::1]", "[1:2]", "[::1]:99999"])
      expect(await hostOf(port, host)).toStartWith("HTTP/1.1 400")
  })

  test("an allowedHosts callback decides, and one that throws refuses", async () => {
    const base = await served(originApp, {
      allowedHosts: (host: string) => {
        if (host === "boom.example") throw new Error("policy crashed")
        return host === "ok.example"
      },
    })
    expect((await fetch(`${base}/`, { headers: { host: "ok.example" } })).status).toBe(200)
    expect((await fetch(`${base}/`, { headers: { host: "no.example" } })).status).toBe(400)
    expect((await fetch(`${base}/`, { headers: { host: "boom.example" } })).status).toBe(400)
  })

  test("an invalid canonicalHost is refused at startup", async () => {
    await expect(
      Promise.resolve().then(() =>
        serve(originApp, { hostname: "127.0.0.1", port: 0, canonicalHost: "bad host" }),
      ),
    ).rejects.toThrow("@nifrajs/node: invalid canonical host bad host")
  })

  test("a protocol resolver that throws answers a bare 500", async () => {
    const base = await served(originApp, {
      protocol: () => {
        throw new Error("resolver crashed")
      },
    })
    const response = await fetch(`${base}/`)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ ok: false, error: "internal_error" })
  })
})
