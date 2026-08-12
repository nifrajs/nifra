import { describe, expect, test } from "bun:test"
import type { NodeResponseContext } from "@nifrajs/core/server"
import { setNodeHeader, withHeaders } from "../src/_utils.ts"

// The shared mutate-in-place-or-clone helper under cors/timing/powered-by/securityHeaders.
describe("withHeaders", () => {
  test("mutable response: mutates in place, returns the SAME instance (no clone)", () => {
    const res = new Response("body", { status: 200 })
    const out = withHeaders(res, (h) => h.set("x-a", "1"))
    expect(out).toBe(res) // same object - allocation-free
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

  test("does not retry a callback that throws its own TypeError", () => {
    let calls = 0
    const res = new Response("body")
    expect(() =>
      withHeaders(res, () => {
        calls++
        throw new TypeError("callback failure")
      }),
    ).toThrow("callback failure")
    expect(calls).toBe(1)
  })
})

// The Node-direct twin of the above: middleware that never builds a Web Response writes one header
// straight onto the outcome record. It keeps the caller's record rather than re-homing it into a
// null-prototype object, so the one name a plain assignment cannot store needs its own path.
const outcome = (headers?: Record<string, string | readonly string[]>): NodeResponseContext => ({
  status: 200,
  headers,
  cookies: undefined,
  body: null,
})

describe("setNodeHeader", () => {
  test("creates the record on first write, then assigns onto the same object", () => {
    const res = outcome()
    setNodeHeader(res, "x-a", "1")
    const record = res.headers
    setNodeHeader(res, "x-b", ["2", "3"])
    expect(res.headers).toBe(record) // same record - no re-home, no dictionary demotion
    expect(res.headers).toEqual({ "x-a": "1", "x-b": ["2", "3"] })
  })

  test("stores a `__proto__` header as own data, leaving the prototype untouched", () => {
    const res = outcome({})
    setNodeHeader(res, "__proto__", "poison")
    const headers = res.headers as Record<string, unknown>
    // A plain assignment here would hit the inherited setter and store nothing at all, so the name
    // would silently vanish from the wire. It has to be an enumerable own property to be written.
    expect(Object.hasOwn(headers, "__proto__")).toBe(true)
    expect(Object.keys(headers)).toEqual(["__proto__"])
    expect(headers["__proto__"]).toBe("poison")
    expect(Object.getPrototypeOf(headers)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>)["poison"]).toBeUndefined()
  })
})
