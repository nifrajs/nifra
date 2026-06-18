import { describe, expect, test } from "bun:test"
import { parseCookies, serializeCookie, server, signValue, unsignValue } from "../src/index.ts"

const request = (method: string, path: string, headers?: Record<string, string>): Request =>
  new Request(`http://x${path}`, headers ? { method, headers } : { method })

describe("parseCookies", () => {
  test("null/empty → {}", () => {
    expect(parseCookies(null)).toEqual({})
    expect(parseCookies(undefined)).toEqual({})
    expect(parseCookies("")).toEqual({})
  })

  test("single, multiple, URL-decoded, quoted", () => {
    expect(parseCookies("sid=abc")).toEqual({ sid: "abc" })
    expect(parseCookies("sid=abc; theme=dark")).toEqual({ sid: "abc", theme: "dark" })
    expect(parseCookies("name=a%20b")).toEqual({ name: "a b" }) // URL-decoded
    expect(parseCookies('q="quoted"')).toEqual({ q: "quoted" }) // DQUOTE-stripped
  })

  test("skips malformed pairs (no '=', leading '=', blank name)", () => {
    expect(parseCookies("novalue; sid=ok")).toEqual({ sid: "ok" }) // no '=' → skipped
    expect(parseCookies("=orphan; sid=ok")).toEqual({ sid: "ok" }) // eq<1 → skipped
    expect(parseCookies(" =x; sid=ok")).toEqual({ sid: "ok" }) // name trims to "" → skipped
  })

  test("a malformed %-escape returns the raw value (never throws)", () => {
    expect(parseCookies("bad=%E0%A4%A")).toEqual({ bad: "%E0%A4%A" })
  })
})

describe("serializeCookie", () => {
  test("bare name=value (URL-encodes the value)", () => {
    expect(serializeCookie("a", "b")).toBe("a=b")
    expect(serializeCookie("a", "x y/z")).toBe("a=x%20y%2Fz")
  })

  test("all attributes", () => {
    const out = serializeCookie("sid", "v", {
      maxAge: 3600,
      domain: "example.com",
      path: "/app",
      expires: new Date(0),
      httpOnly: true,
      secure: true,
      partitioned: true,
      sameSite: "strict",
    })
    expect(out).toContain("sid=v")
    expect(out).toContain("Max-Age=3600")
    expect(out).toContain("Domain=example.com")
    expect(out).toContain("Path=/app")
    expect(out).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT")
    expect(out).toContain("HttpOnly")
    expect(out).toContain("Secure")
    expect(out).toContain("Partitioned")
    expect(out).toContain("SameSite=Strict")
  })

  test("sameSite variants", () => {
    expect(serializeCookie("a", "b", { sameSite: "lax" })).toContain("SameSite=Lax")
    expect(serializeCookie("a", "b", { sameSite: "none" })).toContain("SameSite=None")
    expect(serializeCookie("a", "b", { sameSite: "strict" })).toContain("SameSite=Strict")
  })

  test("rejects an invalid name, non-integer maxAge, injecting path/domain, oversized", () => {
    expect(() => serializeCookie("bad name", "v")).toThrow(/invalid cookie name/)
    expect(() => serializeCookie("a", "v", { maxAge: 1.5 })).toThrow(/maxAge must be an integer/)
    expect(() => serializeCookie("a", "v", { path: "/x;y" })).toThrow(/Path contains an illegal/)
    expect(() => serializeCookie("a", "v", { path: "/x\ny" })).toThrow(/Path contains an illegal/)
    expect(() => serializeCookie("a", "v", { domain: "e\x7fvil" })).toThrow(
      /Domain contains an illegal/,
    )
    expect(() => serializeCookie("big", "x".repeat(5000))).toThrow(/over the 4096B limit/)
  })
})

describe("signValue / unsignValue", () => {
  const secret = "a-secret-at-least-32-bytes-long!!"

  test("round-trips a signed value", async () => {
    const signed = await signValue("session-id-123", secret)
    expect(signed).toContain("session-id-123.")
    expect(await unsignValue(signed, secret)).toBe("session-id-123")
  })

  test("rejects a tampered value, a wrong secret, and a missing/garbage signature", async () => {
    const signed = await signValue("v", secret)
    const [value, sig] = signed.split(".")
    expect(await unsignValue(`tampered.${sig}`, secret)).toBeNull() // value changed
    expect(await unsignValue(signed, "different-secret-also-32-bytes!!")).toBeNull() // wrong key
    expect(await unsignValue("no-signature-segment", secret)).toBeNull() // no dot
    expect(await unsignValue(".onlysig", secret)).toBeNull() // empty value (dot<1)
    expect(await unsignValue(`${value}.!!not-base64!!`, secret)).toBeNull() // bad base64 sig
  })
})

describe("c.cookies (read) + c.set.cookie (write)", () => {
  test("c.cookies parses the request Cookie header (lazy + cached)", async () => {
    const app = server().get("/r", (c) => {
      const first = c.cookies
      const second = c.cookies // second read returns the cached object (same ref)
      return { all: first, cached: first === second }
    })
    const res = await app.fetch(request("GET", "/r", { cookie: "sid=abc; theme=dark" }))
    expect(await res.json()).toEqual({ all: { sid: "abc", theme: "dark" }, cached: true })
  })

  test("c.set.cookie is secure-by-default (HttpOnly; Secure; SameSite=Lax; Path=/)", async () => {
    const app = server().get("/s", (c) => {
      c.set.cookie("sid", "abc")
      return { ok: true }
    })
    const sc = (await app.fetch(request("GET", "/s"))).headers.getSetCookie()
    expect(sc).toHaveLength(1)
    expect(sc[0]).toContain("sid=abc")
    expect(sc[0]).toContain("HttpOnly")
    expect(sc[0]).toContain("Secure")
    expect(sc[0]).toContain("SameSite=Lax")
    expect(sc[0]).toContain("Path=/")
  })

  test("MULTIPLE c.set.cookie calls all survive (multiplicity fix — not collapsed)", async () => {
    const app = server().get("/m", (c) => {
      c.set.cookie("sid", "abc")
      c.set.cookie("csrf", "xyz", { sameSite: "strict" })
      return { ok: true }
    })
    const sc = (await app.fetch(request("GET", "/m"))).headers.getSetCookie()
    expect(sc).toHaveLength(2)
    expect(sc.some((c) => c.includes("sid=abc"))).toBe(true)
    expect(sc.some((c) => c.includes("csrf=xyz") && c.includes("SameSite=Strict"))).toBe(true)
  })

  test("cookies coexist with regular headers", async () => {
    const app = server().get("/both", (c) => {
      c.set.headers["x-custom"] = "1"
      c.set.cookie("a", "1")
      return { ok: true }
    })
    const res = await app.fetch(request("GET", "/both"))
    expect(res.headers.get("x-custom")).toBe("1")
    expect(res.headers.getSetCookie()).toHaveLength(1)
  })

  test("secure can be overridden for local http dev", async () => {
    const app = server().get("/dev", (c) => {
      c.set.cookie("a", "1", { secure: false })
      return null
    })
    const sc = (await app.fetch(request("GET", "/dev"))).headers.getSetCookie()
    expect(sc[0]).not.toContain("Secure")
  })

  test("deleteCookie expires it immediately", async () => {
    const app = server().get("/logout", (c) => {
      c.set.deleteCookie("sid")
      return null
    })
    const sc = (await app.fetch(request("GET", "/logout"))).headers.getSetCookie()
    expect(sc[0]).toContain("sid=")
    expect(sc[0]).toContain("Max-Age=0")
    expect(sc[0]).toContain("Expires=Thu, 01 Jan 1970")
    expect(sc[0]).toContain("Path=/")
  })

  test("a response with no cookies emits no Set-Cookie (lazy path unchanged)", async () => {
    const app = server().get("/none", () => ({ ok: true }))
    expect((await app.fetch(request("GET", "/none"))).headers.getSetCookie()).toHaveLength(0)
  })

  test("cookies set alongside a RETURNED Response are merged onto it (the login redirect pattern)", async () => {
    const app = server().post("/login", (c) => {
      c.set.cookie("sid", "abc")
      return new Response(null, { status: 303, headers: { location: "/" } }) // redirect()
    })
    const res = await app.fetch(request("POST", "/login"))
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("/")
    expect(res.headers.getSetCookie().some((c) => c.includes("sid=abc"))).toBe(true)
  })
})

describe("parseCookies prototype safety (audit 2026-06)", () => {
  test("hostile cookie names are inert own keys on a null-proto object", () => {
    const c = parseCookies("constructor=x; __proto__=y; toString=z; sid=ok")
    expect(Object.getPrototypeOf(c)).toBeNull()
    // Bracket access is the assertion: dot access on constructor/toString resolves through the
    // Object.prototype TYPES, and the whole point is these are inert OWN keys on a null-proto object.
    // biome-ignore lint/complexity/useLiteralKeys: bracket access IS the test
    expect(c["constructor"]).toBe("x")
    // biome-ignore lint/complexity/useLiteralKeys: bracket access IS the test
    expect(c["__proto__"]).toBe("y")
    // biome-ignore lint/complexity/useLiteralKeys: bracket access IS the test
    expect(c["toString"]).toBe("z")
    expect(c.sid).toBe("ok")
    // no global prototype pollution
    expect(({} as Record<string, unknown>).y).toBeUndefined()
  })
})

describe("HMAC secret strength (audit 2026-06, M2)", () => {
  test("signValue rejects a secret under 32 bytes", async () => {
    await expect(signValue("x", "short")).rejects.toThrow(/at least 32 bytes/)
  })
  test("a 32-byte secret signs + round-trips", async () => {
    const secret = "a-secret-that-is-32-bytes-long!!!"
    const signed = await signValue("hello", secret)
    expect(await unsignValue(signed, secret)).toBe("hello")
  })
})
