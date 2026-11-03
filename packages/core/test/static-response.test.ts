import { describe, expect, test } from "bun:test"
import {
  authenticated,
  rejected,
  type ServerOptions,
  server,
  staticResponse,
} from "../src/index.ts"

interface NativeRoutes {
  readonly [path: string]: Readonly<
    Record<string, Response | ((request: Request, server: object) => unknown)>
  >
}

type NativeFallback = (request: Request, server: object) => Response

function nativeRoutes(app: object): NativeRoutes | undefined {
  const fallback: NativeFallback = () => new Response(null)
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: this test inspects the private Bun route-table compiler.
  const build = app as {
    buildBunNativeRoutes(
      fallback: NativeFallback,
      peer: object,
      platformFor: (request: Request, server: object) => object,
    ): NativeRoutes | undefined
  }
  return build.buildBunNativeRoutes(fallback, {}, () => ({}))
}

describe("staticResponse", () => {
  test("installs one bodyless Response in Bun's route table and aliases GET to HEAD", () => {
    const app = server().get("/health", staticResponse({ headers: { "x-health": "ok" } }))
    const route = nativeRoutes(app)?.["/health"]
    const direct = route?.GET

    expect(direct).toBeInstanceOf(Response)
    if (!(direct instanceof Response)) throw new Error("expected a Bun static response value")
    expect(route?.HEAD).toBe(direct)
    expect(direct.body).toBeNull()
    expect(direct.headers.get("x-health")).toBe("ok")
  })

  test("installs a bodyless POST Response in Bun's route table", async () => {
    const app = server().post("/empty", staticResponse())
    const direct = nativeRoutes(app)?.["/empty"]?.POST

    expect(direct).toBeInstanceOf(Response)
    if (!(direct instanceof Response)) throw new Error("expected a Bun static response value")
    expect(direct.body).toBeNull()

    const running = app.listen(0, { hostname: "127.0.0.1" })
    try {
      const response = await fetch(`http://127.0.0.1:${running.port}/empty`, {
        method: "POST",
        body: "ignored",
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("")
    } finally {
      await app.stop({ drainMs: 0 })
    }
  })

  test("keeps null-body status codes on the handler path", () => {
    for (const status of [204, 205, 304]) {
      const app = server().get("/empty", staticResponse({ status }))
      expect(nativeRoutes(app)?.["/empty"]?.GET).not.toBeInstanceOf(Response)
    }
  })

  test("snapshots init and returns fresh responses through app.fetch", async () => {
    const headers = new Headers({ "x-route": "original" })
    const app = server().get("/health", staticResponse({ headers }))
    headers.set("x-route", "mutated")

    const first = await app.fetch(new Request("http://nifra.test/health"))
    first.headers.set("x-route", "changed")
    const second = await app.fetch(new Request("http://nifra.test/health"))

    expect(first).not.toBe(second)
    expect(first.status).toBe(200)
    expect(await first.text()).toBe("")
    expect(second.headers.get("x-route")).toBe("original")
    expect(await second.text()).toBe("")
  })

  test("refuses caller-controlled framing headers", () => {
    expect(() => staticResponse({ headers: { "content-length": "1" } })).toThrow(TypeError)
    expect(() => staticResponse({ headers: { "transfer-encoding": "chunked" } })).toThrow(TypeError)
  })

  test("serves the native static value over Bun and preserves GET/HEAD semantics", async () => {
    const app = server().get("/health", staticResponse({ headers: { "x-health": "ok" } }))
    const running = app.listen(0, { hostname: "127.0.0.1" })
    try {
      for (const method of ["GET", "HEAD"] as const) {
        const response = await fetch(`http://127.0.0.1:${running.port}/health`, { method })
        expect(response.status).toBe(200)
        expect(response.headers.get("x-health")).toBe("ok")
        expect(await response.text()).toBe("")
      }
    } finally {
      await app.stop({ drainMs: 0 })
    }
  })

  test("serves 204 without body bytes and keeps the next response aligned", async () => {
    const app = server()
      .get("/empty", staticResponse({ status: 204 }))
      .get("/ok", () => ({ ok: true }))
    const running = app.listen(0, { hostname: "127.0.0.1" })
    try {
      const empty = await fetch(`http://127.0.0.1:${running.port}/empty`)
      expect(empty.status).toBe(204)
      expect(await empty.text()).toBe("")

      const next = await fetch(`http://127.0.0.1:${running.port}/ok`)
      expect(next.status).toBe(200)
      expect(await next.json()).toEqual({ ok: true })
    } finally {
      await app.stop({ drainMs: 0 })
    }
  })

  test("keeps route hooks on the normal handler path", async () => {
    let beforeHandleCalls = 0
    const app = server()
      .beforeHandle(() => {
        beforeHandleCalls += 1
      })
      .get("/health", staticResponse())

    expect(nativeRoutes(app)?.["/health"]?.GET).not.toBeInstanceOf(Response)
    const response = await app.fetch(new Request("http://nifra.test/health"))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("")
    expect(beforeHandleCalls).toBe(1)
  })

  test("keeps response hooks on the normal handler path", async () => {
    let responseCalls = 0
    const app = server()
      .onResponse((response) => {
        responseCalls += 1
        return response
      })
      .get("/health", staticResponse())

    expect(nativeRoutes(app)?.["/health"]?.GET).not.toBeInstanceOf(Response)
    const response = await app.fetch(new Request("http://nifra.test/health"))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("")
    expect(responseCalls).toBe(1)
  })

  test("does not bypass host validation", () => {
    const app = server({ validateHost: true }).get("/health", staticResponse())
    expect(nativeRoutes(app)?.["/health"]?.GET).not.toBeInstanceOf(Response)
  })

  test("keeps timeout, deadline, admission, and target-normalization routes on the pipeline", () => {
    const options: ServerOptions[] = [
      { requestTimeoutMs: 100 },
      { acceptInboundDeadlines: true },
      { normalizeTarget: true },
      {
        admission: {
          admit: () => ({ admitted: false, response: new Response(null, { status: 429 }) }),
        },
      },
    ]
    for (const option of options) {
      const app = server(option).get("/health", staticResponse())
      expect(nativeRoutes(app)?.["/health"]?.GET).not.toBeInstanceOf(Response)
    }
  })

  test("does not bypass authentication or declared response headers", async () => {
    const auth = server()
      .authenticate({
        id: "token",
        mode: "sync",
        run: (input) =>
          input.headers.get("authorization") === "Bearer ok"
            ? authenticated({ id: "u1" })
            : rejected("unauthenticated"),
      })
      .get("/private", staticResponse())
    expect(nativeRoutes(auth)?.["/private"]?.GET).not.toBeInstanceOf(Response)
    expect((await auth.fetch(new Request("http://nifra.test/private"))).status).toBe(401)

    const headers = server()
      .responseHeaders({ "x-content-policy": "private" })
      .get("/health", staticResponse())
    expect(nativeRoutes(headers)?.["/health"]?.GET).not.toBeInstanceOf(Response)
    expect(
      (await headers.fetch(new Request("http://nifra.test/health"))).headers.get(
        "x-content-policy",
      ),
    ).toBe("private")
  })

  test("preserves listen static precedence and disables the direct value route there", async () => {
    const app = server()
      .get("/health", staticResponse())
      .get("/fallback", staticResponse({ headers: { "x-route": "fallback" } }))
    const files: string[] = []

    const running = app.listen(0, {
      hostname: "127.0.0.1",
      static(request) {
        const path = new URL(request.url).pathname
        files.push(path)
        return path === "/health" ? new Response("file") : undefined
      },
    })
    try {
      const response = await fetch(`http://127.0.0.1:${running.port}/health`)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("file")
      const fallback = await fetch(`http://127.0.0.1:${running.port}/fallback`)
      expect(fallback.status).toBe(200)
      expect(fallback.headers.get("x-route")).toBe("fallback")
      expect(await fallback.text()).toBe("")
      expect(files).toEqual(["/health", "/fallback"])
    } finally {
      await app.stop({ drainMs: 0 })
    }
  })
})
