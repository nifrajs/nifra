import { describe, expect, test } from "bun:test"
import { server, silentLogger } from "@nifrajs/core"
import { t } from "@nifrajs/schema"
import { problemDetails } from "../src/index.ts"

describe("problemDetails()", () => {
  test("converts a framework error into RFC 9457 problem details", async () => {
    const app = server()
      .use(problemDetails())
      .get("/known", () => "ok")

    const res = await app.fetch(new Request("http://x/missing"))

    expect(res.status).toBe(404)
    expect(res.headers.get("content-type")).toContain("application/problem+json")
    expect(await res.json()).toEqual({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      code: "not_found",
    })
  })

  test("preserves validation issues and can include a query-free instance", async () => {
    const app = server()
      .use(problemDetails({ includeInstance: true, typeBase: "https://api.example/problems" }))
      .post("/users", { body: t.object({ name: t.string() }) }, () => ({ ok: true }))

    const res = await app.fetch(
      new Request("http://x/users?token=secret", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    )

    expect(res.status).toBe(422)
    const document = (await res.json()) as {
      readonly type: string
      readonly title: string
      readonly status: number
      readonly code: string
      readonly instance?: string
    }
    expect(document).toMatchObject({
      type: "https://api.example/problems/validation",
      title: "Unprocessable Content",
      status: 422,
      code: "validation",
      instance: "/users",
    })
    expect(document.instance).not.toContain("secret")
  })

  test("converts a raw JSON error response without touching success or existing problems", async () => {
    const app = server({ logger: silentLogger })
      .use(problemDetails())
      .get(
        "/raw",
        () =>
          new Response(JSON.stringify({ ok: false, error: "gone" }), {
            status: 410,
            headers: { "content-type": "application/json" },
          }),
      )
      .get("/success", () => ({ ok: false, error: "business_value" }))
      .get("/already-body", (c) => {
        c.set.status = 410
        c.set.headers["content-type"] = "application/problem+json"
        return { ok: false, error: "gone" }
      })
      .get(
        "/already",
        () =>
          new Response(
            JSON.stringify({ type: "https://example.test/problems/gone", status: 410 }),
            {
              status: 410,
              headers: { "content-type": "application/problem+json" },
            },
          ),
      )

    const raw = await app.fetch(new Request("http://x/raw"))
    expect(raw.status).toBe(410)
    expect(await raw.json()).toMatchObject({ title: "Gone", code: "gone" })

    const success = await app.fetch(new Request("http://x/success"))
    expect(success.headers.get("content-type")).toContain("application/json")
    expect(await success.json()).toEqual({ ok: false, error: "business_value" })

    const alreadyBody = await app.fetch(new Request("http://x/already-body"))
    expect(alreadyBody.headers.get("content-type")).toContain("application/problem+json")
    expect(await alreadyBody.json()).toEqual({ ok: false, error: "gone" })

    const already = await app.fetch(new Request("http://x/already"))
    expect(already.headers.get("content-type")).toContain("application/problem+json")
    expect(await already.json()).toEqual({
      type: "https://example.test/problems/gone",
      status: 410,
    })
  })

  test("bounds inspection and validates the option", async () => {
    expect(() => problemDetails({ maxBytes: -1 })).toThrow(/maxBytes/)

    const app = server({ logger: silentLogger })
      .use(problemDetails({ maxBytes: 8 }))
      .get(
        "/large",
        () =>
          new Response(JSON.stringify({ ok: false, error: "not_found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
      )

    const res = await app.fetch(new Request("http://x/large"))
    expect(res.headers.get("content-type")).toContain("application/json")
    expect(await res.json()).toEqual({ ok: false, error: "not_found" })
  })

  test("leaves an oversized streaming error body intact", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":false,'))
        controller.enqueue(new TextEncoder().encode('"error":"not_found"}'))
        controller.close()
      },
    })
    const app = server({ logger: silentLogger })
      .use(problemDetails({ maxBytes: 8 }))
      .get(
        "/large-stream",
        () =>
          new Response(body, {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
      )

    const res = await app.fetch(new Request("http://x/large-stream"))

    expect(res.headers.get("content-type")).toContain("application/json")
    expect(await res.text()).toBe('{"ok":false,"error":"not_found"}')
  })

  test("leaves non-JSON, encoded, and already-readable errors untouched", async () => {
    const app = server({ logger: silentLogger })
      .use(problemDetails())
      .get("/text", () => new Response("not json", { status: 400 }))
      .get(
        "/encoded",
        () =>
          new Response('{"ok":false,"error":"encoded"}', {
            status: 400,
            headers: { "content-type": "application/json", "content-encoding": "gzip" },
          }),
      )

    const text = await app.fetch(new Request("http://x/text"))
    expect(text.headers.get("content-type") ?? "").not.toContain("problem+json")
    expect(await text.text()).toBe("not json")

    const encoded = await app.fetch(new Request("http://x/encoded"))
    expect(encoded.headers.get("content-type")).toContain("application/json")
    expect(await encoded.text()).toContain('"error":"encoded"')
  })

  test("preserves issue payloads and handles a raw stream read failure", async () => {
    const app = server({ logger: silentLogger })
      .use(problemDetails({ typeBase: "https://example.test/problems" }))
      .get(
        "/issues",
        () =>
          new Response(
            JSON.stringify({ ok: false, error: "invalid", issues: [{ path: ["name"] }] }),
            {
              status: 422,
              headers: { "content-type": "application/json" },
            },
          ),
      )
      .get(
        "/broken",
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(new Error("upstream failed"))
              },
            }),
            { status: 502, headers: { "content-type": "application/json" } },
          ),
      )

    const issues = await app.fetch(new Request("http://x/issues"))
    expect(await issues.json()).toMatchObject({
      type: "https://example.test/problems/invalid",
      status: 422,
      issues: [{ path: ["name"] }],
    })

    const broken = await app.fetch(new Request("http://x/broken"))
    expect(broken.status).toBe(502)
    expect(broken.headers.get("content-type")).toContain("application/json")
  })
})
