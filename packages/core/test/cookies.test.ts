import { describe, expect, test } from "bun:test"
import {
  cookieNamePrefix,
  parseCookies,
  serializeCookie,
  server,
  signValue,
  silentLogger,
  unsignValue,
} from "../src/index.ts"

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

describe("__Secure- / __Host- prefix contract (RFC 6265bis)", () => {
  test("cookieNamePrefix classifies names the way browsers do (case-insensitive)", () => {
    expect(cookieNamePrefix("__Secure-sid")).toBe("secure")
    expect(cookieNamePrefix("__Host-sid")).toBe("host")
    expect(cookieNamePrefix("__secure-sid")).toBe("secure")
    expect(cookieNamePrefix("__HOST-sid")).toBe("host")
    expect(cookieNamePrefix("sid")).toBeUndefined()
    expect(cookieNamePrefix("__nifra_draft")).toBeUndefined() // `__` alone is not a prefix
    expect(cookieNamePrefix("__Secure")).toBeUndefined() // no trailing dash → no prefix
    expect(cookieNamePrefix("_Secure-sid")).toBeUndefined()
  })

  test("__Secure- requires Secure", () => {
    expect(() => serializeCookie("__Secure-sid", "v")).toThrow(/__Secure- requires Secure/)
    expect(() => serializeCookie("__Secure-sid", "v", { secure: false })).toThrow(
      /__Secure- requires Secure/,
    )
    expect(serializeCookie("__Secure-sid", "v", { secure: true })).toContain("Secure")
  })

  test("__Host- requires Secure + Path=/ and forbids Domain", () => {
    expect(() => serializeCookie("__Host-sid", "v", { path: "/" })).toThrow(
      /__Host- requires Secure/,
    )
    expect(() => serializeCookie("__Host-sid", "v", { secure: true })).toThrow(
      /__Host- requires Path=\//,
    )
    expect(() => serializeCookie("__Host-sid", "v", { secure: true, path: "/app" })).toThrow(
      /__Host- requires Path=\//,
    )
    expect(() =>
      serializeCookie("__Host-sid", "v", { secure: true, path: "/", domain: "example.com" }),
    ).toThrow(/__Host- forbids Domain/)
    const ok = serializeCookie("__Host-sid", "v", { secure: true, path: "/" })
    expect(ok).toContain("__Host-sid=v")
    expect(ok).toContain("Secure")
    expect(ok).toContain("Path=/")
  })

  test("lowercase spellings are enforced identically (browsers match case-insensitively)", () => {
    expect(() => serializeCookie("__secure-sid", "v")).toThrow(/__Secure- requires Secure/)
    expect(() => serializeCookie("__host-sid", "v", { secure: true, path: "/x" })).toThrow(
      /__Host- requires Path=\//,
    )
  })

  test("c.set.cookie: a __Host- name works with zero config (secure-by-default satisfies it)", async () => {
    const app = server().get("/s", (c) => {
      c.set.cookie("__Host-sid", "abc")
      return null
    })
    const sc = (await app.fetch(request("GET", "/s"))).headers.getSetCookie()
    expect(sc).toHaveLength(1)
    expect(sc[0]).toContain("__Host-sid=abc")
    expect(sc[0]).toContain("Secure")
    expect(sc[0]).toContain("Path=/")
    expect(sc[0]).not.toContain("Domain")
  })

  test("c.set.cookie: overriding a prefixed cookie into a violation throws (500, not a silent drop)", async () => {
    const app = server({ logger: silentLogger }).get("/bad", (c) => {
      c.set.cookie("__Host-sid", "abc", { secure: false })
      return null
    })
    expect((await app.fetch(request("GET", "/bad"))).status).toBe(500)
  })

  test("deleteCookie on a __Host- name emits Secure so the browser accepts the deletion", async () => {
    // Regression for the Hono CVE-2026-39410 class: a deletion Set-Cookie violating the name's
    // prefix contract is silently discarded by the browser, so "logout" leaves the session alive.
    const app = server().get("/logout", (c) => {
      c.set.deleteCookie("__Host-sid")
      return null
    })
    const sc = (await app.fetch(request("GET", "/logout"))).headers.getSetCookie()
    expect(sc).toHaveLength(1)
    expect(sc[0]).toContain("__Host-sid=")
    expect(sc[0]).toContain("Max-Age=0")
    expect(sc[0]).toContain("Secure")
    expect(sc[0]).toContain("Path=/")
  })

  test("deleteCookie on an unprefixed name stays exactly as before (no Secure added)", async () => {
    const app = server().get("/logout", (c) => {
      c.set.deleteCookie("sid")
      return null
    })
    const sc = (await app.fetch(request("GET", "/logout"))).headers.getSetCookie()
    expect(sc[0]).not.toContain("Secure")
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

  test("rejects non-canonical base64url signatures", async () => {
    const signed = await signValue("v", secret)
    const [value, sig] = signed.split(".")
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    const last = alphabet.indexOf(sig!.at(-1)!)
    // HMAC-SHA256 is 32 bytes → the final base64url character has two unused low bits. Flipping one
    // of them changes the cookie text but not the decoded signature bytes.
    const alternate = alphabet[last ^ 1]
    expect(alternate).toBeDefined()
    expect(await unsignValue(`${value}.${sig!.slice(0, -1)}${alternate}`, secret)).toBeNull()
  })

  test("rotation list: first secret signs, any listed secret verifies", async () => {
    const oldSecret = "old-secret-at-least-32-bytes-ok!!"
    const newSecret = "new-secret-at-least-32-bytes-ok!!"
    const signedByOld = await signValue("v", oldSecret)

    // After rotation ([new, old]) the old cookie still verifies...
    expect(await unsignValue(signedByOld, [newSecret, oldSecret])).toBe("v")
    // ...and new cookies are signed by the first (new) secret.
    const signedNow = await signValue("v", [newSecret, oldSecret])
    expect(await unsignValue(signedNow, newSecret)).toBe("v")
    // Once the old secret is dropped, its cookies stop verifying.
    expect(await unsignValue(signedByOld, [newSecret])).toBeNull()
  })

  test("rotation list: empty list and weak entries throw", async () => {
    await expect(signValue("v", [])).rejects.toThrow(/cannot be empty/)
    await expect(unsignValue("v.sig", [])).rejects.toThrow(/cannot be empty/)
    // A weak entry throws even when an earlier secret would match - a rotation list
    // must not quietly carry a weak key.
    const signed = await signValue("v", secret)
    await expect(unsignValue(signed, [secret, "weak"])).rejects.toThrow(/32 bytes/)
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

  test("MULTIPLE c.set.cookie calls all survive (multiplicity fix - not collapsed)", async () => {
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
