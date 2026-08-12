import { afterEach, describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import {
  handle,
  type LambdaContext,
  type LambdaEnv,
  type LambdaEvent,
  type ResponseStream,
  streamHandle,
} from "../src/index.ts"

/** A golden API Gateway HTTP API / Function URL payload-v2 event. */
const v2Event = (overrides: Partial<LambdaEvent> = {}): LambdaEvent => ({
  rawPath: "/",
  rawQueryString: "",
  headers: { host: "api.example.com", "user-agent": "test" },
  requestContext: {
    domainName: "api.example.com",
    http: { method: "GET", sourceIp: "203.0.113.9" },
  },
  ...overrides,
})

describe("handle()", () => {
  test("golden GET: method, URL, query, and headers reach the app", async () => {
    const app = server().get("/items", (c) =>
      c.json({
        url: c.req.url,
        q: c.query.get("page"),
        ua: c.header("user-agent"),
      }),
    )
    const result = await handle(app)(
      v2Event({ rawPath: "/items", rawQueryString: "page=2&sort=asc" }),
    )
    expect(result.statusCode).toBe(200)
    expect(result.isBase64Encoded).toBe(false)
    expect(result.headers["content-type"]).toStartWith("application/json")
    expect(JSON.parse(result.body)).toEqual({
      url: "https://api.example.com/items?page=2&sort=asc",
      q: "2",
      ua: "test",
    })
  })

  test("the event and context ride on c.env", async () => {
    const app = server<LambdaEnv>().get("/", (c) =>
      c.json({
        sameEvent: c.env.event.rawPath === "/",
        requestId: c.env.context?.awsRequestId ?? null,
      }),
    )
    const context: LambdaContext = { awsRequestId: "req-1" }
    const result = await handle(app)(v2Event(), context)
    expect(JSON.parse(result.body)).toEqual({ sameEvent: true, requestId: "req-1" })
  })

  test("sourceIp feeds core's client-IP seam", async () => {
    const app = server().get("/", (c) => c.json({ ip: c.clientIp ?? null }))
    const result = await handle(app)(v2Event())
    expect(JSON.parse(result.body)).toEqual({ ip: "203.0.113.9" })
  })

  describe("header merging is single-site (GHSA-xgm2-5f3f-mvvc regression)", () => {
    test("the v2 cookies array becomes one cookie header", async () => {
      const app = server().get("/", (c) => c.json({ cookie: c.header("cookie") }))
      const result = await handle(app)(v2Event({ cookies: ["a=1", "b=2"] }))
      expect(JSON.parse(result.body)).toEqual({ cookie: "a=1; b=2" })
    })

    test("a cookie header smuggled into `headers` never reaches the app", async () => {
      const app = server().get("/", (c) => c.json({ cookie: c.header("cookie") }))
      const smuggled = await handle(app)(
        v2Event({
          headers: { host: "api.example.com", cookie: "session=forged" },
          cookies: ["session=real"],
        }),
      )
      expect(JSON.parse(smuggled.body)).toEqual({ cookie: "session=real" })
      // ...even when the cookies array is absent: no second path may resurrect it.
      const alone = await handle(app)(
        v2Event({ headers: { host: "api.example.com", cookie: "session=forged" } }),
      )
      expect(JSON.parse(alone.body)).toEqual({ cookie: null })
    })
  })

  describe("body limits are post-decode (GHSA-rv63-4mwf-qqc2 regression)", () => {
    test("a base64 body is decoded before the app sees it", async () => {
      const app = server().post("/", async (c) => c.json({ body: await c.req.text() }))
      const result = await handle(app)(
        v2Event({
          requestContext: { http: { method: "POST", sourceIp: "203.0.113.9" } },
          body: Buffer.from("hello lambda").toString("base64"),
          isBase64Encoded: true,
        }),
      )
      expect(JSON.parse(result.body)).toEqual({ body: "hello lambda" })
    })

    test("the decoded size is checked, not the event's claims - 413 before the app runs", async () => {
      let ran = false
      const app = server().post("/", async (c) => {
        ran = true
        return c.json({ len: (await c.req.text()).length })
      })
      // 12 decoded bytes claimed by content-length; 3000 real ones. The claim must be ignored.
      const oversized = Buffer.alloc(3000, 65).toString("base64")
      const result = await handle(app, { maxBodyBytes: 1024 })(
        v2Event({
          requestContext: { http: { method: "POST", sourceIp: "203.0.113.9" } },
          headers: { host: "api.example.com", "content-length": "12" },
          body: oversized,
          isBase64Encoded: true,
        }),
      )
      expect(result.statusCode).toBe(413)
      expect(JSON.parse(result.body)).toEqual({ ok: false, error: "payload_too_large" })
      expect(ran).toBe(false)
    })

    // A negative or fractional ceiling compares false against every size, so the limit silently
    // stops existing. Better to refuse the config at construction than to serve unbounded.
    test("a nonsensical maxBodyBytes is refused at construction", () => {
      const app = server().post("/", (c) => c.json({ ok: true }))
      expect(() => handle(app, { maxBodyBytes: -1 })).toThrow(/maxBodyBytes/)
      expect(() => handle(app, { maxBodyBytes: 1.5 })).toThrow(/maxBodyBytes/)
      expect(() => handle(app, { maxBodyBytes: Number.NaN })).toThrow(/maxBodyBytes/)
      expect(() => handle(app, { maxBodyBytes: Number.POSITIVE_INFINITY })).toThrow(/maxBodyBytes/)
      expect(() => handle(app, { maxBodyBytes: 0 })).not.toThrow()
    })

    test("a body on GET is dropped, not an error", async () => {
      const app = server().get("/", (c) => c.json({ ok: true }))
      const result = await handle(app)(v2Event({ body: "stray", isBase64Encoded: false }))
      expect(result.statusCode).toBe(200)
    })
  })

  describe("base64 honesty on responses", () => {
    test("binary bodies go base64 and round-trip exactly", async () => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x01])
      const app = server().get(
        "/",
        () => new Response(bytes, { headers: { "content-type": "application/octet-stream" } }),
      )
      const result = await handle(app)(v2Event())
      expect(result.isBase64Encoded).toBe(true)
      expect(new Uint8Array(Buffer.from(result.body, "base64"))).toEqual(bytes)
    })

    test("UTF-8 text stays text - including a leading BOM", async () => {
      const app = server().get("/", () => new Response("\uFEFFbonjour élan"))
      const result = await handle(app)(v2Event())
      expect(result.isBase64Encoded).toBe(false)
      expect(result.body).toBe("\uFEFFbonjour élan")
    })
  })

  test("Set-Cookie travels in the cookies array, never comma-joined", async () => {
    const app = server().get("/", () => {
      const res = new Response("ok")
      res.headers.append("set-cookie", "a=1; Path=/")
      res.headers.append("set-cookie", "b=2; Path=/; HttpOnly")
      return res
    })
    const result = await handle(app)(v2Event())
    expect(result.cookies).toEqual(["a=1; Path=/", "b=2; Path=/; HttpOnly"])
    expect(result.headers["set-cookie"]).toBeUndefined()
  })

  test("content-length is stripped - the transport owns framing", async () => {
    const app = server().get("/", () => new Response("hi", { headers: { "content-length": "2" } }))
    const result = await handle(app)(v2Event())
    expect(result.headers["content-length"]).toBeUndefined()
  })

  test("a broken app collapses to the flat internal_error 500, no event echo", async () => {
    const broken = {
      fetch(): Response {
        throw new Error("boom with secrets: 203.0.113.9")
      },
    }
    const result = await handle(broken)(v2Event())
    expect(result.statusCode).toBe(500)
    expect(result.body).toBe('{"ok":false,"error":"internal_error"}')
    expect(result.headers["content-type"]).toBe("application/json")
  })

  test("waitUntil work settles before the handler returns", async () => {
    let done = false
    const app = server().get("/", (c) => {
      c.waitUntil(
        new Promise<void>((resolve) =>
          setTimeout(() => {
            done = true
            resolve()
          }, 10),
        ),
      )
      return c.json({ ok: true })
    })
    const result = await handle(app)(v2Event())
    expect(result.statusCode).toBe(200)
    expect(done).toBe(true)
  })
})

describe("streamHandle()", () => {
  interface CapturedStream {
    metadata: { statusCode: number; headers: Record<string, string>; cookies?: string[] } | null
    chunks: Uint8Array[]
    ended: boolean
  }

  const mockAwslambda = (): CapturedStream => {
    const captured: CapturedStream = { metadata: null, chunks: [], ended: false }
    ;(globalThis as Record<string, unknown>).awslambda = {
      streamifyResponse: (handler: unknown) => handler,
      HttpResponseStream: {
        from(stream: ResponseStream, metadata: CapturedStream["metadata"]) {
          captured.metadata = metadata
          return stream
        },
      },
    }
    return captured
  }

  const makeStream = (captured: CapturedStream): ResponseStream => ({
    write(chunk) {
      captured.chunks.push(
        typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk),
      )
      return true
    },
    end() {
      captured.ended = true
    },
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).awslambda
  })

  test("throws a clear error outside the Lambda runtime", () => {
    expect(() => streamHandle(server())).toThrow(/awslambda/)
  })

  test("streams status, headers, cookies, and body chunks", async () => {
    const captured = mockAwslambda()
    const app = server().get("/", () => {
      const res = new Response("streamed body", { status: 201, headers: { "x-a": "1" } })
      res.headers.append("set-cookie", "s=1; Path=/")
      return res
    })
    await streamHandle(app)(v2Event(), makeStream(captured))
    expect(captured.metadata?.statusCode).toBe(201)
    expect(captured.metadata?.headers["x-a"]).toBe("1")
    expect(captured.metadata?.cookies).toEqual(["s=1; Path=/"])
    expect(captured.ended).toBe(true)
    const body = Buffer.concat(captured.chunks).toString("utf8")
    expect(body).toBe("streamed body")
  })

  test("the post-decode 413 streams like any other response", async () => {
    const captured = mockAwslambda()
    let ran = false
    const app = server().post("/", (c) => {
      ran = true
      return c.json({ ok: true })
    })
    await streamHandle(app, { maxBodyBytes: 4 })(
      v2Event({
        requestContext: { http: { method: "POST", sourceIp: "203.0.113.9" } },
        body: "way past four bytes",
      }),
      makeStream(captured),
    )
    expect(captured.metadata?.statusCode).toBe(413)
    expect(ran).toBe(false)
  })

  test("a broken app streams the flat 500", async () => {
    const captured = mockAwslambda()
    const broken = {
      fetch(): Response {
        throw new Error("boom")
      },
    }
    await streamHandle(broken)(v2Event(), makeStream(captured))
    expect(captured.metadata?.statusCode).toBe(500)
    expect(Buffer.concat(captured.chunks).toString("utf8")).toBe(
      '{"ok":false,"error":"internal_error"}',
    )
    expect(captured.ended).toBe(true)
  })
})
