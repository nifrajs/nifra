import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import {
  type JwkKey,
  type JwtClaims,
  jwk,
  jwks,
  jwt,
  tryVerifyJwt,
  verifyJwt,
} from "../src/index.ts"

const SECRET = "0123456789abcdef0123456789abcdef"
const ENC = new TextEncoder()

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bin = ""
  for (const b of view) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function hmacToken(
  claims: JwtClaims,
  header: Record<string, unknown> = {},
  secret = SECRET,
): Promise<string> {
  const head = b64url(ENC.encode(JSON.stringify({ alg: "HS256", typ: "JWT", ...header })))
  const body = b64url(ENC.encode(JSON.stringify(claims)))
  const key = await crypto.subtle.importKey(
    "raw",
    ENC.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, ENC.encode(`${head}.${body}`))
  return `${head}.${body}.${b64url(sig)}`
}

async function rsaToken(claims: JwtClaims, kid = "rsa-1"): Promise<{ token: string; jwk: JwkKey }> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )
  const head = b64url(ENC.encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid })))
  const body = b64url(ENC.encode(JSON.stringify(claims)))
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    pair.privateKey,
    ENC.encode(`${head}.${body}`),
  )
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as unknown as JwkKey
  return { token: `${head}.${body}.${b64url(sig)}`, jwk: { ...publicJwk, kid, alg: "RS256" } }
}

describe("jwt() / verifyJwt()", () => {
  test("authorizes an HS256 token and exposes typed claims", async () => {
    interface Claims extends JwtClaims {
      readonly sub: string
      readonly role: string
    }
    const token = await hmacToken({
      sub: "u1",
      role: "admin",
      iss: "issuer",
      aud: "api",
      exp: 2_000_000_000,
    })
    const auth = jwt<Claims>({
      key: SECRET,
      algorithms: ["HS256"],
      issuer: "issuer",
      audience: "api",
      now: () => 1_900_000_000,
    })
    const app = server()
      .use(auth)
      .get("/me", (c) => ({ sub: auth.requireClaims(c.req).sub, role: auth.claims(c.req)?.role }))

    const res = await app.fetch(
      new Request("http://x/me", { headers: { authorization: `Bearer ${token}` } }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sub: "u1", role: "admin" })
  })

  test("rejects expired, missing-exp, alg none, and disallowed algorithms", async () => {
    const expiredBase = { sub: "u1", exp: 100 }
    const validBase = { sub: "u1", exp: 2_000_000_000 }
    const expired = await hmacToken(expiredBase)
    await expect(
      verifyJwt(expired, { key: SECRET, algorithms: ["HS256"], now: () => 101 }),
    ).rejects.toThrow(/expired/)

    await expect(
      verifyJwt(await hmacToken({ sub: "u1" }), { key: SECRET, algorithms: ["HS256"] }),
    ).rejects.toThrow(/exp/)

    const none = `${b64url(ENC.encode(JSON.stringify({ alg: "none" })))}.${b64url(
      ENC.encode(JSON.stringify({ exp: 2_000_000_000 })),
    )}.x`
    await expect(verifyJwt(none, { key: SECRET, algorithms: ["HS256"] })).rejects.toThrow(/none/)

    await expect(
      verifyJwt(await hmacToken(validBase), { key: SECRET, algorithms: ["RS256"] }),
    ).rejects.toThrow(/algorithm/)

    await expect(
      verifyJwt(await hmacToken({ ...validBase, aud: "api" }), {
        key: SECRET,
        algorithms: ["HS256"],
        audience: "other",
      }),
    ).rejects.toThrow(/audience/)

    await expect(
      verifyJwt(await hmacToken({ ...validBase, iss: "issuer" }), {
        key: SECRET,
        algorithms: ["HS256"],
        issuer: "other",
      }),
    ).rejects.toThrow(/issuer/)

    await expect(
      verifyJwt(await hmacToken(validBase, { crit: ["exp"] }), {
        key: SECRET,
        algorithms: ["HS256"],
      }),
    ).rejects.toThrow(/crit/)
  })

  test("tryVerifyJwt returns a typed Result instead of throwing", async () => {
    interface Claims extends JwtClaims {
      readonly sub: string
    }
    const token = await hmacToken({ sub: "u1", exp: 2_000_000_000 })

    const ok = await tryVerifyJwt<Claims>(token, {
      key: SECRET,
      algorithms: ["HS256"],
      now: () => 1_900_000_000,
    })
    if (!ok.ok) throw ok.error
    expect(ok.data.claims.sub).toBe("u1")
    expect(ok.data.header.alg).toBe("HS256")

    const bad = await tryVerifyJwt("not-a-jwt", { key: SECRET, algorithms: ["HS256"] })
    expect(bad.ok).toBe(false)
    if (bad.ok) throw new Error("expected invalid token to fail")
    expect(bad.error).toBeInstanceOf(Error)
    expect(bad.error.message).toContain("expected three segments")
  })

  test("optional mode passes invalid or missing tokens without claims", async () => {
    const auth = jwt({ key: SECRET, algorithms: ["HS256"], optional: true })
    const app = server()
      .use(auth)
      .get("/maybe", (c) => ({ claims: auth.claims(c.req) }))
    expect(await (await app.fetch(new Request("http://x/maybe"))).json()).toEqual({ claims: null })
    expect(
      await (
        await app.fetch(new Request("http://x/maybe", { headers: { authorization: "Bearer bad" } }))
      ).json(),
    ).toEqual({ claims: null })
  })

  test("verifies RS256 with a direct JWK", async () => {
    const { token, jwk: publicJwk } = await rsaToken({ sub: "u1", exp: 2_000_000_000 })
    const verified = await verifyJwt(token, {
      key: jwk(publicJwk),
      algorithms: ["RS256"],
      now: () => 1_900_000_000,
    })
    expect(verified.claims.sub).toBe("u1")
  })

  test("verifies via JWKS, requires kid, and caches the key set", async () => {
    const { token, jwk: publicJwk } = await rsaToken({ sub: "u1", exp: 2_000_000_000 }, "kid-1")
    let calls = 0
    const fakeFetch = (async () => {
      calls += 1
      return Response.json({ keys: [publicJwk] })
    }) as unknown as typeof fetch
    const resolver = jwks({
      url: "https://issuer.test/jwks.json",
      fetch: fakeFetch,
      cacheMs: 60_000,
    })

    const opts = { key: resolver, algorithms: ["RS256"] as const, now: () => 1_900_000_000 }
    expect((await verifyJwt(token, opts)).claims.sub).toBe("u1")
    expect((await verifyJwt(token, opts)).claims.sub).toBe("u1")
    expect(calls).toBe(1)

    const noKid = await hmacToken({ sub: "u1", exp: 2_000_000_000 })
    await expect(verifyJwt(noKid, { ...opts, algorithms: ["HS256"] })).rejects.toThrow(/key/)
  })

  test("uses a bounded stale JWKS cache when refresh fails", async () => {
    const { token, jwk: publicJwk } = await rsaToken({ sub: "u1", exp: 2_000_000_000 }, "kid-stale")
    let calls = 0
    const fakeFetch = (async () => {
      calls += 1
      if (calls === 1) return Response.json({ keys: [publicJwk] })
      throw new Error("network down")
    }) as unknown as typeof fetch
    const resolver = jwks({
      url: "https://issuer.test/jwks.json",
      fetch: fakeFetch,
      cacheMs: 0,
      staleMs: 60_000,
    })

    const opts = { key: resolver, algorithms: ["RS256"] as const, now: () => 1_900_000_000 }
    expect((await verifyJwt(token, opts)).claims.sub).toBe("u1")
    expect((await verifyJwt(token, opts)).claims.sub).toBe("u1")
    expect(calls).toBe(2)
  })

  test("JWKS can fail closed on refresh errors when staleMs is disabled", async () => {
    const { token, jwk: publicJwk } = await rsaToken(
      { sub: "u1", exp: 2_000_000_000 },
      "kid-strict",
    )
    let calls = 0
    const fakeFetch = (async () => {
      calls += 1
      if (calls === 1) return Response.json({ keys: [publicJwk] })
      throw new Error("network down")
    }) as unknown as typeof fetch
    const resolver = jwks({
      url: "https://issuer.test/jwks.json",
      fetch: fakeFetch,
      cacheMs: 0,
      staleMs: 0,
    })

    const opts = { key: resolver, algorithms: ["RS256"] as const, now: () => 1_900_000_000 }
    expect((await verifyJwt(token, opts)).claims.sub).toBe("u1")
    await expect(verifyJwt(token, opts)).rejects.toThrow(/network down/)
    expect(calls).toBe(2)
  })

  test("validates JWKS URL protocol", () => {
    expect(() => jwks({ url: "http://issuer.test/jwks.json" })).toThrow(/https/)
    expect(() => jwks({ url: "http://localhost/jwks.json" })).not.toThrow()
    expect(() => jwks({ url: "https://issuer.test/jwks.json", timeoutMs: 0 })).toThrow(/timeout/)
    expect(() => jwks({ url: "https://issuer.test/jwks.json", staleMs: -1 })).toThrow(/staleMs/)
    expect(() => jwks({ url: "https://issuer.test/jwks.json", maxBytes: 0 })).toThrow(/maxBytes/)
  })

  test("bounds JWKS response reads before buffering untrusted bodies", async () => {
    const byLength = jwks({
      url: "https://issuer.test/jwks.json",
      maxBytes: 8,
      fetch: (async () =>
        new Response("{}", {
          headers: { "content-length": "999" },
        })) as unknown as typeof fetch,
    })
    await expect(byLength({ alg: "RS256", kid: "kid" }, {})).rejects.toThrow(/too large/)

    let cancelled = false
    const streamed = jwks({
      url: "https://issuer.test/jwks.json",
      maxBytes: 8,
      fetch: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(ENC.encode('{"keys":'))
              controller.enqueue(ENC.encode("[]}".repeat(10)))
            },
            cancel() {
              cancelled = true
            },
          }),
        )) as unknown as typeof fetch,
    })
    await expect(streamed({ alg: "RS256", kid: "kid" }, {})).rejects.toThrow(/too large/)
    expect(cancelled).toBe(true)
  })
})
