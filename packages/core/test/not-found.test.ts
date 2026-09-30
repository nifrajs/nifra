import { afterEach, describe, expect, test } from "bun:test"
import { FrameworkError, server, status } from "../src/index.ts"
import { nodeDirect } from "../src/node-direct.ts"
import type { LogFields, Logger } from "../src/server/logger.ts"
import { type NotFoundHandler, type NotFoundInput, notFound } from "../src/server/not-found.ts"
import { notFoundInput } from "../src/server/not-found-answer.ts"

const DEFAULT_404 = { ok: false, error: "not_found" }
const PLAIN_500 = { ok: false, error: "internal_error" }

const miss = (path = "/absent", init?: RequestInit): Request => new Request(`http://t${path}`, init)

// A runtime's `Request` constructor normalizes or rejects an unusual method, so it cannot stand in
// for a transport that delivers the token as sent. Shadowing the accessor reproduces that.
function requestWith(method: string, url: string): Request {
  const request = new Request(url)
  Object.defineProperty(request, "method", { value: method })
  return request
}

interface ErrorLog {
  readonly message: string
  readonly fields: LogFields | undefined
}

function capture(): { readonly logger: Logger; readonly errors: ErrorLog[] } {
  const errors: ErrorLog[] = []
  return {
    errors,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message, fields) => {
        errors.push({ message, fields })
      },
    },
  }
}

const answerOf = async (response: Response): Promise<[number, unknown]> => [
  response.status,
  await response.json(),
]

describe("notFound(): what it answers", () => {
  test("a server without it keeps the default 404", async () => {
    const app = server().get("/", () => "home")
    expect(await answerOf(await app.fetch(miss()))).toEqual([404, DEFAULT_404])
  })

  test("the handler's body and headers are sent, as a 404", async () => {
    const app = server()
      .use(
        notFound(({ pathname }) =>
          Response.json(
            { ok: false, error: "no_such_route", pathname },
            { headers: { "x-miss": "1" } },
          ),
        ),
      )
      .get("/", () => "home")
    const response = await app.fetch(miss("/absent"))
    expect(response.status).toBe(404)
    expect(response.headers.get("x-miss")).toBe("1")
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(await response.json()).toEqual({
      ok: false,
      error: "no_such_route",
      pathname: "/absent",
    })
    // A route that exists is untouched.
    expect((await app.fetch(miss("/"))).status).toBe(200)
  })

  test("a miss is never a success: every 2xx is sent as a 404", async () => {
    for (const given of [200, 201, 202, 204, 206, 299]) {
      const app = server().use(
        notFound(() => new Response(given === 204 ? null : "body", { status: given })),
      )
      const response = await app.fetch(miss())
      expect(response.status).toBe(404)
      expect(await response.text()).toBe(given === 204 ? "" : "body")
    }
  })

  test("a redirect, another 4xx, or a 5xx is sent as built", async () => {
    const cases: ReadonlyArray<readonly [Response, number]> = [
      [new Response(null, { status: 301, headers: { location: "/new" } }), 301],
      [new Response(null, { status: 308, headers: { location: "/new" } }), 308],
      [new Response("gone", { status: 410 }), 410],
      [new Response("teapot", { status: 418 }), 418],
      [new Response("down", { status: 503 }), 503],
    ]
    for (const [answer, expected] of cases) {
      const app = server().use(notFound(() => answer))
      const response = await app.fetch(miss())
      expect(response.status).toBe(expected)
      if (expected < 400) expect(response.headers.get("location")).toBe("/new")
    }
  })

  test("undefined, sync or async, is the default 404", async () => {
    const sync = server().use(notFound(() => undefined))
    const async_ = server().use(notFound(async () => undefined))
    const implicit = server().use(notFound(() => {}))
    for (const app of [sync, async_, implicit]) {
      expect(await answerOf(await app.fetch(miss()))).toEqual([404, DEFAULT_404])
    }
  })

  test("an async handler is awaited", async () => {
    const app = server().use(
      notFound(async ({ pathname }) => {
        await Bun.sleep(1)
        return Response.json({ pathname })
      }),
    )
    expect(await answerOf(await app.fetch(miss("/later")))).toEqual([404, { pathname: "/later" }])
  })

  test("a thrown Response is treated like a returned one", async () => {
    const thrown = server().use(
      notFound(() => {
        throw Response.json({ thrown: true })
      }),
    )
    expect(await answerOf(await thrown.fetch(miss()))).toEqual([404, { thrown: true }])

    const rejected = server().use(
      notFound(async () => {
        throw new Response(null, { status: 302, headers: { location: "/login" } })
      }),
    )
    const response = await rejected.fetch(miss())
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe("/login")
  })
})

describe("notFound(): what the handler is given", () => {
  test("the request line, the headers, the platform, and a signal - never the body", async () => {
    let seen: NotFoundInput<{ readonly region: string }> | undefined
    const app = server<{ readonly region: string }>().use(
      notFound<{ readonly region: string }>((input) => {
        seen = input
        return undefined
      }),
    )
    const request = new Request("http://t/a%2Fb/c%20d?x=1&y=%2F", {
      method: "POST",
      headers: { "x-trace": "abc", "content-type": "text/plain" },
      body: "unread",
    })
    const platform = { env: { region: "eu" } }
    await app.fetch(request, platform)

    expect(seen).toBeDefined()
    const input = seen as NotFoundInput<{ readonly region: string }>
    expect(input.method).toBe("POST")
    expect(input.url).toBe("http://t/a%2Fb/c%20d?x=1&y=%2F")
    // Exactly as received: the router's lookup key, not a decoded path.
    expect(input.pathname).toBe("/a%2Fb/c%20d")
    expect(input.headers.get("x-trace")).toBe("abc")
    expect(input.header("X-Trace")).toBe("abc")
    expect(input.header("absent")).toBeNull()
    expect(input.platform).toBe(platform)
    expect(input.platform?.env?.region).toBe("eu")
    expect(input.signal.aborted).toBe(false)
    expect(Object.keys(input).sort()).toEqual([
      "header",
      "headers",
      "method",
      "pathname",
      "platform",
      "signal",
      "url",
    ])
    // The body was never touched.
    expect(request.bodyUsed).toBe(false)
  })

  test("the url and the headers are built only when read", () => {
    const reads = { url: 0, headers: 0 }
    const source = {
      method: "GET",
      get url() {
        reads.url++
        return "http://t/lazy"
      },
      get headers() {
        reads.headers++
        return new Headers({ a: "1" })
      },
    } as unknown as Request
    const input = notFoundInput(source, "/lazy", undefined)
    expect(reads).toEqual({ url: 0, headers: 0 })
    expect(input.url).toBe("http://t/lazy")
    expect(input.headers.get("a")).toBe("1")
    expect(reads).toEqual({ url: 1, headers: 1 })
  })
})

describe("notFound(): when it does not run", () => {
  const counted = (): { readonly handler: NotFoundHandler; readonly calls: string[] } => {
    const calls: string[] = []
    return {
      calls,
      handler: ({ method, pathname }) => {
        calls.push(`${method} ${pathname}`)
        return new Response("custom")
      },
    }
  }

  test("a path that exists under another method stays a 405 with Allow", async () => {
    const { handler, calls } = counted()
    const app = server()
      .use(notFound(handler))
      .post("/items", () => ({ ok: true }))
      .get("/files/*", () => "file")
    const wrongMethod = await app.fetch(miss("/items"))
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get("allow")).toBe("POST")
    expect(await wrongMethod.json()).toEqual({ ok: false, error: "method_not_allowed" })
    expect((await app.fetch(miss("/files/a", { method: "DELETE" }))).status).toBe(405)
    expect(calls).toEqual([])
  })

  test("a route's own 404 is the route's answer", async () => {
    const { handler, calls } = counted()
    const app = server()
      .use(notFound(handler))
      .get("/users/:id", () => status(404, { ok: false, error: "no_such_user" }))
      .get("/raw", () => new Response("raw miss", { status: 404 }))
    expect(await answerOf(await app.fetch(miss("/users/7")))).toEqual([
      404,
      { ok: false, error: "no_such_user" },
    ])
    expect(await (await app.fetch(miss("/raw"))).text()).toBe("raw miss")
    expect(calls).toEqual([])
  })

  test("a malformed parameter stays a 400", async () => {
    const { handler, calls } = counted()
    const app = server()
      .use(notFound(handler))
      .get("/users/:id", (c) => ({ id: c.params.id }))
    const response = await app.fetch(miss("/users/%E0%A4%A"))
    expect(response.status).toBe(400)
    expect(calls).toEqual([])
  })

  test("a mounted handler's own 404 is that handler's answer", async () => {
    const { handler, calls } = counted()
    const app = server()
      .use(notFound(handler))
      .mountFetch("/legacy", () => new Response("legacy miss", { status: 404 }))
    const response = await app.fetch(miss("/legacy/anything"))
    expect(response.status).toBe(404)
    expect(await response.text()).toBe("legacy miss")
    expect(calls).toEqual([])
    // Outside the mount it is this server's miss.
    expect(await (await app.fetch(miss("/elsewhere"))).text()).toBe("custom")
    expect(calls).toEqual(["GET /elsewhere"])
  })

  test("a request whose method no route could be registered under gets the default 404", async () => {
    const { handler, calls } = counted()
    const app = server()
      .use(notFound(handler))
      .get("/", () => "home")
    for (const method of ["get", "Get", "GET ", "G_T", "9GET", "", `G${"E".repeat(32)}`]) {
      expect(await answerOf(await app.fetch(requestWith(method, "http://t/absent")))).toEqual([
        404,
        DEFAULT_404,
      ])
    }
    expect(calls).toEqual([])
    // A well-formed method nobody registered is still a miss the handler answers.
    await app.fetch(requestWith("PROPFIND", "http://t/absent"))
    expect(calls).toEqual(["PROPFIND /absent"])
  })
})

describe("notFound(): a handler that fails", () => {
  const faults: ReadonlyArray<readonly [string, NotFoundHandler]> = [
    [
      "throws",
      () => {
        throw new Error("secret detail")
      },
    ],
    [
      "rejects",
      async () => {
        throw new Error("secret detail")
      },
    ],
    ["throws a non-error", () => Promise.reject("secret detail")],
    ["returns a string", (() => "secret detail") as unknown as NotFoundHandler],
    ["returns an object", (() => ({ secret: "secret detail" })) as unknown as NotFoundHandler],
    ["returns null", (() => null) as unknown as NotFoundHandler],
    [
      "returns a status() result",
      (() => status(200, { secret: "secret detail" })) as unknown as NotFoundHandler,
    ],
    ["returns Response.error()", () => Response.error()],
    [
      "returns a Response whose body was read",
      async () => {
        const response = new Response("secret detail")
        await response.text()
        return response
      },
    ],
  ]

  for (const [label, handler] of faults) {
    test(`${label}: logged once, plain 500, no error text on the wire`, async () => {
      const { logger, errors } = capture()
      const app = server({ logger }).use(notFound(handler))
      const response = await app.fetch(miss("/absent?token=1"))
      expect(response.status).toBe(500)
      const text = await response.text()
      expect(JSON.parse(text)).toEqual(PLAIN_500)
      expect(text).not.toContain("secret")
      expect(errors.length).toBe(1)
      expect(errors[0]?.message).toBe("unhandled request error")
      expect(errors[0]?.fields).toMatchObject({ method: "GET", path: "/absent" })
    })
  }

  test("errorLogDetail decides how much of the error reaches the log", async () => {
    const boom: NotFoundHandler = () => {
      throw new Error("secret detail")
    }
    const full = capture()
    await server({ logger: full.logger }).use(notFound(boom)).fetch(miss())
    expect(full.errors[0]?.fields?.detail).toBe("secret detail")
    expect(typeof full.errors[0]?.fields?.stack).toBe("string")

    const message = capture()
    await server({ logger: message.logger, errorLogDetail: "message" })
      .use(notFound(boom))
      .fetch(miss())
    expect(message.errors[0]?.fields?.detail).toBe("secret detail")
    expect(message.errors[0]?.fields).not.toHaveProperty("stack")

    const none = capture()
    await server({ logger: none.logger, errorLogDetail: "none" }).use(notFound(boom)).fetch(miss())
    expect(none.errors.length).toBe(1)
    expect(JSON.stringify(none.errors[0]?.fields)).not.toContain("secret")
  })
})

describe("notFound(): the answer takes the server's response path", () => {
  test("static response headers and onResponse hooks apply to it", async () => {
    const seen: number[] = []
    const app = server()
      .responseHeaders({ "x-frame-options": "DENY" })
      .onResponse((response) => {
        seen.push(response.status)
        response.headers.set("x-hooked", "1")
        return response
      })
      .use(notFound(() => Response.json({ custom: true })))
    const response = await app.fetch(miss())
    expect(response.status).toBe(404)
    expect(response.headers.get("x-frame-options")).toBe("DENY")
    expect(response.headers.get("x-hooked")).toBe("1")
    expect(await response.json()).toEqual({ custom: true })
    expect(seen).toEqual([404])
  })

  test("an onRequest hook that answers runs before it", async () => {
    let calls = 0
    const app = server()
      .onRequest((request) =>
        request.headers.get("x-token") === "ok"
          ? undefined
          : Response.json({ ok: false }, { status: 401 }),
      )
      .use(
        notFound(() => {
          calls++
          return new Response("custom")
        }),
      )
    expect((await app.fetch(miss())).status).toBe(401)
    expect(calls).toBe(0)
    expect((await app.fetch(miss("/absent", { headers: { "x-token": "ok" } }))).status).toBe(404)
    expect(calls).toBe(1)
  })

  test("the Node-direct lane answers the same", async () => {
    const { logger, errors } = capture()
    const app = server({ logger })
      .use(nodeDirect())
      .responseHeaders({ "x-frame-options": "DENY" })
      .use(
        notFound(({ pathname }) => {
          if (pathname === "/boom") throw new Error("secret detail")
          if (pathname === "/default") return undefined
          if (pathname === "/moved") {
            return new Response(null, { status: 308, headers: { location: "/new" } })
          }
          return Response.json({ pathname }, { status: 200 })
        }),
      )
      .post("/items", () => ({ ok: true }))

    const web = async (path: string): Promise<[number, string]> => {
      const response = await app.fetch(miss(path))
      return [response.status, await response.text()]
    }
    const node = async (path: string): Promise<[number, string]> => {
      const outcome = (await app.resolveNode(miss(path))) as
        | { readonly kind: "response"; readonly response: Response }
        | {
            readonly kind: "json" | "body"
            readonly status: number
            readonly body: string | Uint8Array | null
          }
      if (outcome.kind === "response")
        return [outcome.response.status, await outcome.response.text()]
      const body = outcome.body
      return [
        outcome.status,
        typeof body === "string" ? body : body === null ? "" : new TextDecoder().decode(body),
      ]
    }
    for (const path of ["/absent", "/default", "/moved", "/boom", "/items"]) {
      expect(await node(path)).toEqual(await web(path))
    }
    expect((await node("/absent"))[0]).toBe(404)
    expect((await node("/boom"))[0]).toBe(500)
    expect((await node("/items"))[0]).toBe(405)
    // Two lanes each answered `/boom` twice above and once more here.
    expect(errors.length).toBe(3)
  })

  test("a listening server answers a miss through it", async () => {
    const app = server()
      .responseHeaders({ "x-frame-options": "DENY" })
      .use(notFound(({ pathname }) => Response.json({ pathname }, { headers: { "x-miss": "1" } })))
      .get("/", () => "home")
      .get("/users/:id", (c) => ({ id: c.params.id }))
    const running = app.listen(0, { hostname: "127.0.0.1" })
    try {
      const base = `http://127.0.0.1:${running.port}`
      const response = await fetch(`${base}/absent/path`)
      expect(response.status).toBe(404)
      expect(response.headers.get("x-miss")).toBe("1")
      expect(response.headers.get("x-frame-options")).toBe("DENY")
      expect(await response.json()).toEqual({ pathname: "/absent/path" })

      const head = await fetch(`${base}/absent`, { method: "HEAD" })
      expect(head.status).toBe(404)
      expect(await head.text()).toBe("")

      expect((await fetch(`${base}/users/7`)).status).toBe(200)
      expect((await fetch(`${base}/users/7`, { method: "POST" })).status).toBe(405)
    } finally {
      await running.stop()
    }
  })
})

describe("notFound(): bounded by requestTimeoutMs", () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  afterEach(() => {
    process.off("unhandledRejection", onUnhandled)
    unhandled.length = 0
  })

  // The handler is held open by a gate the test releases only after it has the answer, so the
  // answer can only have come from the deadline - no wall-clock margin to get wrong under load.
  const gate = (): { readonly held: Promise<void>; readonly release: () => void } => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    return { held, release }
  }

  test("a slow handler gets the timeout answer and its signal aborts", async () => {
    const { held, release } = gate()
    let abortedAfter: boolean | undefined
    let abortEvents = 0
    const app = server({ requestTimeoutMs: 20 }).use(
      notFound(async ({ signal }) => {
        signal.addEventListener("abort", () => abortEvents++)
        await held
        abortedAfter = signal.aborted
        return new Response("late")
      }),
    )
    expect(await answerOf(await app.fetch(miss()))).toEqual([
      503,
      { ok: false, error: "request_timeout" },
    ])
    expect(abortEvents).toBe(1)
    release()
    await Bun.sleep(1)
    expect(abortedAfter).toBe(true)
  })

  test("a handler that rejects after the deadline is observed, not unhandled", async () => {
    process.on("unhandledRejection", onUnhandled)
    const { held, release } = gate()
    const { logger, errors } = capture()
    const app = server({ requestTimeoutMs: 20, logger }).use(
      notFound(async () => {
        await held
        throw new Error("late failure")
      }),
    )
    expect((await app.fetch(miss())).status).toBe(503)
    expect(errors.length).toBe(0)
    release()
    await Bun.sleep(20)
    expect(unhandled).toEqual([])
    // The late fault is still logged: it happened, even though its answer was discarded.
    expect(errors.length).toBe(1)
  })

  test("the Node-direct lane is bounded the same way", async () => {
    const { held, release } = gate()
    const app = server({ requestTimeoutMs: 20 })
      .use(nodeDirect())
      .use(
        notFound(async () => {
          await held
          return new Response("late")
        }),
      )
    const outcome = (await app.resolveNode(miss())) as {
      readonly kind: string
      readonly status?: number
      readonly response?: Response
    }
    expect(outcome.status ?? outcome.response?.status).toBe(503)
    release()
    await Bun.sleep(1)
  })

  test("a handler inside the deadline answers, and the signal stays open", async () => {
    const signals: AbortSignal[] = []
    const app = server({ requestTimeoutMs: 1000 }).use(
      notFound(async ({ signal }) => {
        signals.push(signal)
        await Bun.sleep(2)
        return new Response("in time")
      }),
    )
    const response = await app.fetch(miss())
    expect(response.status).toBe(404)
    expect(await response.text()).toBe("in time")
    expect(signals[0]?.aborted).toBe(false)
  })

  test("a synchronous handler answers without a race", async () => {
    const app = server({ requestTimeoutMs: 1000 }).use(notFound(() => new Response("sync")))
    const result = app.fetch(miss())
    // Not a promise: a configured timeout costs a synchronous answer nothing.
    expect(result).toBeInstanceOf(Response)
    expect(await (result as Response).text()).toBe("sync")
  })

  test("with no timeout configured the signal never aborts", async () => {
    let signal: AbortSignal | undefined
    const app = server().use(
      notFound((input) => {
        signal = input.signal
        return undefined
      }),
    )
    await app.fetch(miss())
    await app.fetch(miss())
    expect(signal?.aborted).toBe(false)
  })
})

describe("notFound(): applying it", () => {
  const handler: NotFoundHandler = () => new Response("custom")

  test("needs a function", () => {
    expect(() => notFound(undefined as unknown as NotFoundHandler)).toThrow(
      "notFound() needs a handler function",
    )
    expect(() => notFound({} as unknown as NotFoundHandler)).toThrow(TypeError)
  })

  test("a server takes one handler", () => {
    const app = server().use(notFound(handler))
    expect(() => app.use(notFound(handler))).toThrow("notFound() is already applied to this server")
    // The same plugin value twice is refused too, not silently skipped.
    const plugin = notFound(handler)
    const other = server().use(plugin)
    expect(() => other.use(plugin)).toThrow("notFound() is already applied to this server")
  })

  test("inside a group it is refused", async () => {
    expect(() => server().group("/api", (api) => api.use(notFound(handler)))).toThrow(
      "notFound() inside a group answers nothing - apply it to the parent server",
    )
    // A parent's handler covers a miss under the group's prefix.
    const app = server()
      .use(notFound(handler))
      .group("/api", (api) => api.get("/users", () => []))
    expect(() => app.group("/v2", (v2) => v2.use(notFound(handler)))).toThrow(
      "notFound() inside a group answers nothing - apply it to the parent server",
    )
    const response = await app.fetch(miss("/api/absent"))
    expect(response.status).toBe(404)
    expect(await response.text()).toBe("custom")
  })

  test("after listen() it is refused", async () => {
    const app = server().get("/", () => "home")
    const running = app.listen(0, { hostname: "127.0.0.1" })
    try {
      let thrown: unknown
      try {
        app.use(notFound(handler))
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(FrameworkError)
      expect((thrown as FrameworkError).code).toBe("SERVER_SEALED")
      // Applied directly, around `use()`, the seam refuses it as well.
      expect(() => notFound(handler)(app)).toThrow(FrameworkError)
      expect(await answerOf(await fetch(`http://127.0.0.1:${running.port}/absent`))).toEqual([
        404,
        DEFAULT_404,
      ])
    } finally {
      await running.stop()
    }
  })

  test("merge() does not carry a merged server's handler", async () => {
    const child = server()
      .use(notFound(handler))
      .get("/child", () => "child")
    const app = server().merge(child)
    expect((await app.fetch(miss("/child"))).status).toBe(200)
    expect(await answerOf(await app.fetch(miss()))).toEqual([404, DEFAULT_404])
    // The standalone child still answers with its own.
    expect(await (await child.fetch(miss())).text()).toBe("custom")
  })

  test("it can be applied after the routes", async () => {
    const app = server()
      .get("/", () => "home")
      .use(notFound(handler))
    expect(await (await app.fetch(miss())).text()).toBe("custom")
    expect((await app.fetch(miss("/"))).status).toBe(200)
  })
})

describe("notFound(): a fault in what surrounds it", () => {
  const throwingLogger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {
      throw new Error("log sink down")
    },
  }
  const handlers: ReadonlyArray<readonly [string, NotFoundHandler]> = [
    [
      "sync throw",
      () => {
        throw new Error("secret")
      },
    ],
    ["rejection", () => Promise.reject(new Error("secret"))],
    ["non-Response", () => "secret" as unknown as Response],
  ]

  test("a logger that throws does not change the 500", async () => {
    for (const requestTimeoutMs of [0, 1000]) {
      for (const [label, handler] of handlers) {
        const app = server({ logger: throwingLogger, requestTimeoutMs }).use(notFound(handler))
        const response = await app.fetch(miss())
        expect([label, await answerOf(response)]).toEqual([
          label,
          [500, { ok: false, error: "internal_error" }],
        ])
      }
    }
  })

  test("an onResponse hook that throws fails the request as it does for the default 404", async () => {
    const hook = (): never => {
      throw new Error("hook down")
    }
    const outcome = async (run: () => unknown): Promise<string> => {
      try {
        await run()
        return "answered"
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    }
    const { logger } = capture()
    const plain = await outcome(() => server({ logger }).onResponse(hook).fetch(miss()))
    expect(plain).toBe("hook down")
    const answers: ReadonlyArray<NotFoundHandler> = [
      () => new Response("x"),
      async () => new Response("x"),
    ]
    for (const requestTimeoutMs of [0, 1000]) {
      for (const handler of answers) {
        const app = server({ logger, requestTimeoutMs }).onResponse(hook).use(notFound(handler))
        expect(await outcome(() => app.fetch(miss()))).toBe(plain)
      }
    }
  })
})
