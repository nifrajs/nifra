import { describe, expect, setSystemTime, test } from "bun:test"
import { server } from "@nifrajs/core"
import {
  type JwkKey,
  type JwtAlgorithm,
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

/** A `fetch` that answers every call with `respond`. */
function fetchStub(respond: () => Promise<Response>): typeof fetch {
  return Object.assign(respond, { preconnect: fetch.preconnect })
}

const RS256: readonly JwtAlgorithm[] = ["RS256"]

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
  test("required claims must be own claims, not inherited Object properties", async () => {
    const token = await hmacToken({ sub: "u1", exp: 2_000_000_000 })
    await expect(
      verifyJwt(token, {
        key: SECRET,
        algorithms: ["HS256"],
        requiredClaims: ["toString"],
        now: () => 1_900_000_000,
      }),
    ).rejects.toThrow(/toString/)
  })

  // A caller-supplied CryptoKey used to be handed to `subtle.verify` untouched, so the header's
  // `alg` decided the digest while the key decided nothing. An HS512 key verifying an HS256 header,
  // or an RSA public key standing in for the HMAC secret, is a confused-deputy the allow-list of
  // algorithms cannot see.
  test("a CryptoKey that does not match the header algorithm is rejected", async () => {
    const claims = { sub: "u1", exp: 2_000_000_000 }
    const token = await hmacToken(claims)
    const now = (): number => 1_900_000_000

    const wrongHash = await crypto.subtle.importKey(
      "raw",
      ENC.encode(SECRET),
      { name: "HMAC", hash: "SHA-512" },
      false,
      ["verify"],
    )
    await expect(verifyJwt(token, { key: wrongHash, algorithms: ["HS256"], now })).rejects.toThrow(
      /CryptoKey/,
    )

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
    // Right digest, wrong family and wrong key type - an asymmetric public key is not a shared secret.
    await expect(
      verifyJwt(token, { key: pair.publicKey, algorithms: ["HS256"], now }),
    ).rejects.toThrow(/CryptoKey/)
    // And the mirror: an HMAC secret cannot stand in for the RS256 verification key.
    const rsHead = b64url(ENC.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })))
    const rsBody = b64url(ENC.encode(JSON.stringify(claims)))
    const rsSig = await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      pair.privateKey,
      ENC.encode(`${rsHead}.${rsBody}`),
    )
    const rsToken = `${rsHead}.${rsBody}.${b64url(rsSig)}`
    const hmacVerify = await crypto.subtle.importKey(
      "raw",
      ENC.encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    )
    await expect(
      verifyJwt(rsToken, { key: hmacVerify, algorithms: ["RS256"], now }),
    ).rejects.toThrow(/CryptoKey/)

    // A key that cannot verify is refused before `subtle.verify` throws an opaque DOMException.
    const signOnly = await crypto.subtle.importKey(
      "raw",
      ENC.encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
    await expect(verifyJwt(token, { key: signOnly, algorithms: ["HS256"], now })).rejects.toThrow(
      /CryptoKey/,
    )

    // The matching key still works, so the guard is not simply refusing every CryptoKey.
    expect(
      (await verifyJwt(token, { key: hmacVerify, algorithms: ["HS256"], now })).claims.sub,
    ).toBe("u1")
    expect(
      (await verifyJwt(rsToken, { key: pair.publicKey, algorithms: ["RS256"], now })).claims,
    ).toBeDefined()
  })

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

  test("rejects a signature spelled with non-canonical base64url trailing bits", async () => {
    const token = await hmacToken({ sub: "u1", exp: 2_000_000_000 })
    const options = { key: SECRET, algorithms: ["HS256"] as const, now: () => 1_900_000_000 }
    expect((await tryVerifyJwt(token, options)).ok).toBe(true)
    // A 32-byte HS256 signature is 43 chars: the last one carries 2 unused bits. `atob` ignores them,
    // so setting one decodes to the same bytes - a second spelling of one signature.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    const last = alphabet.indexOf(token.at(-1) ?? "")
    const twin = `${token.slice(0, -1)}${alphabet[last | 1]}`
    expect((await tryVerifyJwt(twin, options)).ok).toBe(false)
  })

  test("accepts the Bearer auth-scheme case-insensitively", async () => {
    const token = await hmacToken({ sub: "u1", exp: 2_000_000_000 })
    const app = server()
      .use(jwt({ key: SECRET, algorithms: ["HS256"], now: () => 1_900_000_000 }))
      .get("/me", () => "ok")
    for (const scheme of ["bearer", "BEARER"]) {
      const res = await app.fetch(
        new Request("http://x/me", { headers: { authorization: `${scheme} ${token}` } }),
      )
      expect(res.status).toBe(200)
    }
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

  test("inside the stale window a request is answered at once while one refresh runs behind it", async () => {
    const { token, jwk: publicJwk } = await rsaToken({ sub: "u1", exp: 2_000_000_000 }, "kid-swr")
    let calls = 0
    const hung = Promise.withResolvers<Response>()
    const fakeFetch = fetchStub(async () => {
      calls += 1
      return calls === 1 ? Response.json({ keys: [publicJwk] }) : hung.promise
    })
    const resolver = jwks({
      url: "https://issuer.test/jwks.json",
      fetch: fakeFetch,
      cacheMs: 100,
      staleMs: 60_000,
    })
    const opts = { key: resolver, algorithms: RS256, now: () => 1_900_000_000 }
    try {
      setSystemTime(new Date(1_000_000))
      expect((await verifyJwt(token, opts)).claims.sub).toBe("u1")
      setSystemTime(new Date(1_000_150))
      expect((await verifyJwt(token, opts)).claims.sub).toBe("u1")
      expect((await verifyJwt(token, opts)).claims.sub).toBe("u1")
      // One refresh, still in flight, answered neither request.
      expect(calls).toBe(2)
    } finally {
      setSystemTime()
      hung.resolve(Response.json({ keys: [publicJwk] }))
    }
  })

  test("a kid the cached set lacks refetches the set once per cooldown", async () => {
    const first = await rsaToken({ sub: "old", exp: 2_000_000_000 }, "kid-old")
    const rotated = await rsaToken({ sub: "new", exp: 2_000_000_000 }, "kid-new")
    const forged = await rsaToken({ sub: "forged", exp: 2_000_000_000 }, "kid-unknown")
    let calls = 0
    const fakeFetch = fetchStub(async () => {
      calls += 1
      return Response.json({ keys: calls === 1 ? [first.jwk] : [first.jwk, rotated.jwk] })
    })
    const resolver = jwks({
      url: "https://issuer.test/jwks.json",
      fetch: fakeFetch,
      cacheMs: 600_000,
      cooldownMs: 30_000,
    })
    const opts = { key: resolver, algorithms: RS256, now: () => 1_900_000_000 }
    try {
      setSystemTime(new Date(2_000_000))
      expect((await verifyJwt(first.token, opts)).claims.sub).toBe("old")
      setSystemTime(new Date(2_040_000))
      expect((await verifyJwt(rotated.token, opts)).claims.sub).toBe("new")
      expect(calls).toBe(2)
      await expect(verifyJwt(forged.token, opts)).rejects.toThrow(/key/)
      expect(calls).toBe(2)
      setSystemTime(new Date(2_070_001))
      await expect(verifyJwt(forged.token, opts)).rejects.toThrow(/key/)
      expect(calls).toBe(3)
    } finally {
      setSystemTime()
    }
  })

  test("a failed JWKS fetch is remembered for failureCooldownMs instead of refetched per request", async () => {
    const { token, jwk: publicJwk } = await rsaToken({ sub: "u1", exp: 2_000_000_000 }, "kid-down")
    let calls = 0
    let down = true
    const fakeFetch = fetchStub(async () => {
      calls += 1
      if (down) throw new Error("idp down")
      return Response.json({ keys: [publicJwk] })
    })
    const resolver = jwks({ url: "https://issuer.test/jwks.json", fetch: fakeFetch })
    const opts = { key: resolver, algorithms: RS256, now: () => 1_900_000_000 }
    try {
      setSystemTime(new Date(3_000_000))
      await expect(verifyJwt(token, opts)).rejects.toThrow(/idp down/)
      await expect(verifyJwt(token, opts)).rejects.toThrow(/idp down/)
      setSystemTime(new Date(3_004_999))
      await expect(verifyJwt(token, opts)).rejects.toThrow(/idp down/)
      // One fetch answered all three: none of them waited on a fetch of its own.
      expect(calls).toBe(1)
      down = false
      setSystemTime(new Date(3_005_000))
      expect((await verifyJwt(token, opts)).claims.sub).toBe("u1")
      expect(calls).toBe(2)
    } finally {
      setSystemTime()
    }
  })

  test("an empty JWKS is not refetched per request", async () => {
    const { token } = await rsaToken({ sub: "u1", exp: 2_000_000_000 }, "kid-empty")
    let calls = 0
    const empty = jwks({
      url: "https://issuer.test/jwks.json",
      fetch: fetchStub(async () => {
        calls += 1
        return Response.json({ keys: [] })
      }),
      cooldownMs: 0,
    })
    const opts = { key: empty, algorithms: RS256, now: () => 1_900_000_000 }
    await expect(verifyJwt(token, opts)).rejects.toThrow(/key/)
    await expect(verifyJwt(token, opts)).rejects.toThrow(/key/)
    expect(calls).toBe(1)
  })

  test("a stale set starts one background refresh per failure window, not one per request", async () => {
    const { token, jwk: publicJwk } = await rsaToken({ sub: "u1", exp: 2_000_000_000 }, "kid-bg")
    let staleCalls = 0
    const stale = jwks({
      url: "https://issuer.test/jwks.json",
      fetch: fetchStub(async () => {
        staleCalls += 1
        if (staleCalls === 1) return Response.json({ keys: [publicJwk] })
        throw new Error("network down")
      }),
      cacheMs: 0,
      staleMs: 60_000,
    })
    const staleOpts = { key: stale, algorithms: RS256, now: () => 1_900_000_000 }
    expect((await verifyJwt(token, staleOpts)).claims.sub).toBe("u1")
    expect((await verifyJwt(token, staleOpts)).claims.sub).toBe("u1") // starts the failing refresh
    // Let that refresh settle, so the next request finds no fetch in flight to join.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await verifyJwt(token, staleOpts)).claims.sub).toBe("u1")
    expect(staleCalls).toBe(2)
  })

  test("failureCooldownMs: 0 fetches again for every request after a failure", async () => {
    const { token } = await rsaToken({ sub: "u1", exp: 2_000_000_000 }, "kid-zero")
    let calls = 0
    const resolver = jwks({
      url: "https://issuer.test/jwks.json",
      fetch: fetchStub(async () => {
        calls += 1
        throw new Error("idp down")
      }),
      failureCooldownMs: 0,
    })
    const opts = { key: resolver, algorithms: RS256, now: () => 1_900_000_000 }
    await expect(verifyJwt(token, opts)).rejects.toThrow(/idp down/)
    await expect(verifyJwt(token, opts)).rejects.toThrow(/idp down/)
    expect(calls).toBe(2)
  })

  test("validates JWKS URL protocol", () => {
    expect(() => jwks({ url: "http://issuer.test/jwks.json" })).toThrow(/https/)
    expect(() => jwks({ url: "http://localhost/jwks.json" })).not.toThrow()
    expect(() => jwks({ url: "https://issuer.test/jwks.json", timeoutMs: 0 })).toThrow(/timeout/)
    expect(() => jwks({ url: "https://issuer.test/jwks.json", staleMs: -1 })).toThrow(/staleMs/)
    expect(() =>
      jwks({ url: "https://issuer.test/jwks.json", failureCooldownMs: Number.NaN }),
    ).toThrow(/failureCooldownMs/)
    expect(() => jwks({ url: "https://issuer.test/jwks.json", maxBytes: 0 })).toThrow(/maxBytes/)
  })

  test("bounds JWKS response reads before buffering untrusted bodies", async () => {
    let declaredCancelled = false
    const byLength = jwks({
      url: "https://issuer.test/jwks.json",
      maxBytes: 8,
      fetch: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: (controller) => controller.enqueue(ENC.encode("{}")),
            cancel() {
              declaredCancelled = true
              throw new Error("source already gone")
            },
          }),
          { headers: { "content-length": "999" } },
        )) as unknown as typeof fetch,
    })
    await expect(byLength({ alg: "RS256", kid: "kid" }, {})).rejects.toThrow(/too large/)
    await Bun.sleep(0)
    expect(declaredCancelled).toBe(true)

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
