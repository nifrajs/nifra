import { describe, expect, test } from "bun:test"
import { withHeaders } from "../src/_utils.ts"

// The shared mutate-in-place-or-clone helper under cors/timing/powered-by/securityHeaders.
describe("withHeaders", () => {
  test("mutable response: mutates in place, returns the SAME instance (no clone)", () => {
    const res = new Response("body", { status: 200 })
    const out = withHeaders(res, (h) => h.set("x-a", "1"))
    expect(out).toBe(res) // same object — allocation-free
    expect(out.headers.get("x-a")).toBe("1")
  })

  test("applies a full mutation chain (set + append) once", () => {
    const res = Response.json({ ok: true })
    const out = withHeaders(res, (h) => {
      h.set("x-a", "1")
      h.append("vary", "Origin")
      h.set("x-b", "2")
    })
    expect(out).toBe(res)
    expect(out.headers.get("x-a")).toBe("1")
    expect(out.headers.get("x-b")).toBe("2")
    expect(out.headers.get("vary")).toBe("Origin")
  })

  test("immutable response: clones, applies to the copy, preserves status/body", async () => {
    // Simulate an immutable-headers response (Response.redirect/error or a proxied fetch on
    // Node/Deno/workerd) without depending on the runtime: a Response-like whose headers throw.
    const immutable = {
      body: "upstream",
      status: 502,
      statusText: "Bad Gateway",
      headers: new Proxy(new Headers({ "x-up": "1" }), {
        get(target, prop) {
          if (prop === "set" || prop === "append") {
            return () => {
              throw new TypeError("immutable")
            }
          }
          const v = Reflect.get(target, prop)
          return typeof v === "function" ? v.bind(target) : v
        },
      }),
    } as unknown as Response
    const out = withHeaders(immutable, (h) => h.set("x-a", "1"))
    expect(out).not.toBe(immutable) // cloned
    expect(out.status).toBe(502)
    expect(out.headers.get("x-a")).toBe("1")
    expect(out.headers.get("x-up")).toBe("1") // original headers carried over
    expect(await out.text()).toBe("upstream")
  })
})
