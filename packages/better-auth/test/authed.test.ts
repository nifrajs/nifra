import { describe, expect, test } from "bun:test"
import { authed, type Principal, requirePrincipal, requireSession } from "@nifrajs/better-auth"
import { server } from "@nifrajs/core"
import { NIFRA_ASSURANCE } from "@nifrajs/core/assurance"
import { defineContract, implement } from "@nifrajs/core/contract"
import { reflectRoutes } from "@nifrajs/core/reflection"
import { t } from "@nifrajs/schema"
import { isResponseResult } from "../../core/src/server/runtime-core.ts"

/**
 * Structural better-auth stubs - no DB, no better-auth install. Each returns a typed `{ user, session }`
 * only when the test cookie is present, exactly the contract `requirePrincipal`/`authed` consume. Concrete
 * user shapes (rather than `Record<string, unknown>`) keep `c.principal.user` typed through inference.
 */
const plainAuth = {
  handler: async (): Promise<Response> => Response.json({ ok: true }),
  api: {
    getSession: async ({ headers }: { headers: Headers }) =>
      headers.get("cookie") === "session=valid"
        ? { user: { id: "u1", email: "a@b.c" }, session: { id: "s1", expiresAt: 0 } }
        : null,
  },
  options: { basePath: "/api/auth" },
}

const tenantAuth = {
  handler: async (): Promise<Response> => Response.json({ ok: true }),
  api: {
    getSession: async ({ headers }: { headers: Headers }) =>
      headers.get("cookie") === "session=valid"
        ? {
            user: { id: "u2", email: "t@b.c", tenantId: "t-42" },
            session: { id: "s2", expiresAt: 0 },
          }
        : null,
  },
  options: { basePath: "/api/auth" },
}

const orgAuth = {
  handler: async (): Promise<Response> => Response.json({ ok: true }),
  api: {
    getSession: async ({ headers }: { headers: Headers }) =>
      headers.get("cookie") === "session=valid"
        ? { user: { id: "u3", orgId: "org-7" }, session: { id: "s3", expiresAt: 0 } }
        : null,
  },
  options: { basePath: "/api/auth" },
}

const withCookie = (path: string, method = "GET"): Request =>
  new Request(`http://x${path}`, { method, headers: { cookie: "session=valid" } })
const anon = (path: string): Request => new Request(`http://x${path}`)
const rejectionOf = (thrown: unknown) => {
  expect(thrown).not.toBeInstanceOf(Response)
  if (!isResponseResult(thrown)) throw new Error("expected a Nifra ResponseResult")
  return thrown
}

describe("authed() plugin - fail closed", () => {
  test("publishes authenticated assurance evidence for downstream routes", () => {
    const app = server()
      .use(authed(plainAuth))
      .get("/me", (c) => ({ id: c.principal.userId }))

    expect(reflectRoutes(app)[0]?.assurance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: NIFRA_ASSURANCE.AUTHENTICATED,
          source: "better-auth",
        }),
      ]),
    )
  })

  test("no session -> 401 and the handler does NOT run", async () => {
    let ran = false
    const app = server()
      .use(authed(plainAuth))
      .get("/me", (c) => {
        ran = true
        return { id: c.principal.userId } // c.principal is non-null and typed - no `!`
      })
    const res = await app.fetch(anon("/me"))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, error: "unauthorized" })
    expect(ran).toBe(false)
  })

  test("valid session -> handler runs with a populated c.principal", async () => {
    const app = server()
      .use(authed(plainAuth))
      .get("/me", (c) => {
        // Type-level: user/userId/sessionId are typed, no non-null assertion.
        const email: string = c.principal.user.email
        return { userId: c.principal.userId, sessionId: c.principal.sessionId, email }
      })
    const res = await app.fetch(withCookie("/me"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ userId: "u1", sessionId: "s1", email: "a@b.c" })
  })

  test("requireTenant with no resolvable tenant -> 403 and the handler does NOT run", async () => {
    let ran = false
    const app = server()
      .use(authed(plainAuth, { requireTenant: true }))
      .get("/me", (c) => {
        ran = true
        return { t: c.principal.tenantId }
      })
    const res = await app.fetch(withCookie("/me"))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: "forbidden" })
    expect(ran).toBe(false)
  })

  test("requireTenant with a tenant present -> 200 with the tenantId (typed string)", async () => {
    const app = server()
      .use(authed(tenantAuth, { requireTenant: true }))
      .get("/me", (c) => {
        // Type-level: with requireTenant, tenantId is `string`, not `string | undefined`.
        const tenantId: string = c.principal.tenantId
        return { tenantId }
      })
    const res = await app.fetch(withCookie("/me"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tenantId: "t-42" })
  })

  test("redirectTo -> 302 to the login path (no session)", async () => {
    const app = server()
      .use(authed(plainAuth, { redirectTo: "/login" }))
      .get("/me", (c) => ({ id: c.principal.userId }))
    const res = await app.fetch(anon("/me"))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/login")
  })
})

describe("authed() - tenant resolution", () => {
  test("default tenantOf falls back to user.orgId", async () => {
    const app = server()
      .use(authed(orgAuth, { requireTenant: true }))
      .get("/me", (c) => ({ tenantId: c.principal.tenantId }))
    expect(await (await app.fetch(withCookie("/me"))).json()).toEqual({ tenantId: "org-7" })
  })

  test("a custom tenantOf overrides the default", async () => {
    const app = server()
      .use(authed(plainAuth, { requireTenant: true, tenantOf: (u) => `custom-${u.id}` }))
      .get("/me", (c) => ({ tenantId: c.principal.tenantId }))
    expect(await (await app.fetch(withCookie("/me"))).json()).toEqual({ tenantId: "custom-u1" })
  })

  test("without requireTenant, a resolvable tenant is still exposed (optional)", async () => {
    const app = server()
      .use(authed(tenantAuth))
      .get("/me", (c) => ({ tenantId: c.principal.tenantId ?? null }))
    expect(await (await app.fetch(withCookie("/me"))).json()).toEqual({ tenantId: "t-42" })
  })

  test("a BLANK tenant fails closed under requireTenant (not treated as resolved)", async () => {
    // A user whose tenantId is "" (a NOT-NULL column defaulted to empty) must NOT satisfy requireTenant.
    const blankTenantAuth = {
      handler: async (): Promise<Response> => Response.json({ ok: true }),
      api: {
        getSession: async ({ headers }: { headers: Headers }) =>
          headers.get("cookie") === "session=valid"
            ? { user: { id: "u4", tenantId: "" }, session: { id: "s4", expiresAt: 0 } }
            : null,
      },
      options: { basePath: "/api/auth" },
    }
    let ran = false
    const app = server()
      .use(authed(blankTenantAuth, { requireTenant: true }))
      .get("/me", (c) => {
        ran = true
        return { t: c.principal.tenantId }
      })
    const res = await app.fetch(withCookie("/me"))
    expect(res.status).toBe(403)
    expect(ran).toBe(false)

    // Same for a custom tenantOf that returns an empty string.
    try {
      await requirePrincipal(tenantAuth, withCookie("/x"), {
        requireTenant: true,
        tenantOf: () => "",
      })
      throw new Error("expected requirePrincipal to throw")
    } catch (err) {
      expect(rejectionOf(err).plain?.status).toBe(403)
    }
  })
})

describe("authed() - contract-first mode", () => {
  test("the pre-applied derive threads principal into the contract's handlers", async () => {
    const contract = defineContract({ me: { method: "GET", path: "/me" } })
    const app = implement(
      contract,
      { me: (c) => ({ userId: c.principal.userId, tenantId: c.principal.tenantId }) },
      server().use(authed(tenantAuth, { requireTenant: true })),
    )
    const res = await app.fetch(withCookie("/me"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ userId: "u2", tenantId: "t-42" })
  })

  test("contract mode still fails closed with no session -> 401", async () => {
    const contract = defineContract({ me: { method: "GET", path: "/me" } })
    const app = implement(
      contract,
      { me: (c) => ({ userId: c.principal.userId }) },
      server().use(authed(plainAuth)),
    )
    expect((await app.fetch(anon("/me"))).status).toBe(401)
  })
})

describe("requirePrincipal() direct guard", () => {
  test("returns a mapped principal for an authenticated request", async () => {
    const principal = await requirePrincipal(tenantAuth, withCookie("/x"), { requireTenant: true })
    // Type-level: tenantId is a non-optional string under requireTenant.
    const tenantId: string = principal.tenantId
    expect(principal.userId).toBe("u2")
    expect(principal.sessionId).toBe("s2")
    expect(tenantId).toBe("t-42")
  })

  test("throws a 401 Nifra ResponseResult when unauthenticated", async () => {
    try {
      await requirePrincipal(plainAuth, anon("/x"))
      throw new Error("expected requirePrincipal to throw")
    } catch (err) {
      expect(rejectionOf(err).plain?.status).toBe(401)
    }
  })

  test("throws a 403 Nifra ResponseResult when requireTenant and no tenant resolves", async () => {
    try {
      await requirePrincipal(plainAuth, withCookie("/x"), { requireTenant: true })
      throw new Error("expected requirePrincipal to throw")
    } catch (err) {
      const rejection = rejectionOf(err)
      expect(rejection.plain?.status).toBe(403)
      expect(await rejection.toResponse().json()).toEqual({ ok: false, error: "forbidden" })
    }
  })

  test("throws a 302 Nifra ResponseResult when redirectTo is set and unauthenticated", async () => {
    try {
      await requirePrincipal(plainAuth, anon("/x"), { redirectTo: "/login" })
      throw new Error("expected requirePrincipal to throw")
    } catch (err) {
      const rejection = rejectionOf(err)
      expect(rejection.plain?.status).toBe(302)
      expect(rejection.toResponse().headers.get("location")).toBe("/login")
    }
  })

  test("checks the session before reading a protected request body", async () => {
    const app = server()
      .use(authed(plainAuth))
      .post("/write", { body: t.object({ name: t.string() }) }, (c) => ({ name: c.body.name }))
    let bodyReads = 0
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"))
        controller.close()
      },
      pull() {
        bodyReads += 1
      },
    })
    const unauthenticated = await app.fetch(
      new Request("http://x/write", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit),
    )
    expect(unauthenticated.status).toBe(401)
    expect(bodyReads).toBe(0)

    const malformed = await app.fetch(
      new Request("http://x/write", {
        method: "POST",
        headers: { cookie: "session=valid", "content-type": "application/json" },
        body: "{}",
      }),
    )
    expect(malformed.status).toBe(422)
  })

  test("provider failures and malformed sessions fail closed as 503", async () => {
    const failingAuth = {
      handler: async (): Promise<Response> => Response.json({ ok: true }),
      api: {
        getSession: async (): Promise<never> => {
          throw new Error("database unavailable")
        },
      },
      options: { basePath: "/api/auth" },
    }
    const malformedAuth = {
      handler: async (): Promise<Response> => Response.json({ ok: true }),
      api: {
        getSession: async () => ({ user: { id: "" }, session: { id: "s1" } }),
      },
      options: { basePath: "/api/auth" },
    }
    const failing = server()
      .use(authed(failingAuth))
      .get("/private", () => ({ ok: true }))
    const malformed = server()
      .use(authed(malformedAuth))
      .get("/private", () => ({ ok: true }))
    expect((await failing.fetch(withCookie("/private"))).status).toBe(503)
    expect((await malformed.fetch(withCookie("/private"))).status).toBe(503)
  })

  test("whitespace-only identity fields fail closed as 503", async () => {
    const malformedAuth = {
      handler: async (): Promise<Response> => Response.json({ ok: true }),
      api: {
        getSession: async ({ headers }: { headers: Headers }) =>
          headers.get("cookie") === "session=valid"
            ? { user: { id: "   " }, session: { id: "s1" } }
            : null,
      },
      options: { basePath: "/api/auth" },
    }
    const malformedSessionIdAuth = {
      handler: async (): Promise<Response> => Response.json({ ok: true }),
      api: {
        getSession: async ({ headers }: { headers: Headers }) =>
          headers.get("cookie") === "session=valid"
            ? { user: { id: "u1" }, session: { id: "\t\n" } }
            : null,
      },
      options: { basePath: "/api/auth" },
    }
    const userId = server()
      .use(authed(malformedAuth))
      .get("/private", () => ({ ok: true }))
    const sessionId = server()
      .use(authed(malformedSessionIdAuth))
      .get("/private", () => ({ ok: true }))
    expect((await userId.fetch(withCookie("/private"))).status).toBe(503)
    expect((await sessionId.fetch(withCookie("/private"))).status).toBe(503)
  })

  test("malformed session records and tenant mappings fail closed as 503", async () => {
    const malformedRecordAuth = {
      handler: async (): Promise<Response> => Response.json({ ok: true }),
      api: {
        getSession: async () => ({ user: null, session: { id: "s1" } }),
      },
      options: { basePath: "/api/auth" },
    }
    const malformedTenantAuth = {
      handler: async (): Promise<Response> => Response.json({ ok: true }),
      api: {
        getSession: async () => ({ user: { id: "u1" }, session: { id: "s1" } }),
      },
      options: { basePath: "/api/auth" },
    }
    const malformedRecord = server()
      .use(authed(malformedRecordAuth))
      .get("/private", () => ({ ok: true }))
    const malformedTenant = server()
      .use(
        authed(malformedTenantAuth, {
          tenantOf: () => 42 as unknown as string,
        }),
      )
      .get("/private", () => ({ ok: true }))

    expect((await malformedRecord.fetch(withCookie("/private"))).status).toBe(503)
    expect((await malformedTenant.fetch(withCookie("/private"))).status).toBe(503)
  })

  test("rejects an invalid redirect configuration before a valid session can bypass it", async () => {
    expect(() =>
      requireSession(plainAuth, withCookie("/x"), { redirectTo: "//evil.example" }),
    ).toThrow(/same-origin path/)
    expect(() => authed(plainAuth, { redirectTo: "https://evil.example" })).toThrow(
      /same-origin path/,
    )
  })
})

// Type-level: the exported Principal shape is usable standalone.
const _shape: Principal<{ id: string }> = { user: { id: "z" }, userId: "z", sessionId: "s" }
void _shape

// Negative type probe - proves `c.principal` is a CONCRETE type, not `any` (which would mean the plugin
// silently collapsed the server + its typed client). If principal were `any`, the bogus-field access below
// would type-check and the `@ts-expect-error` would be UNUSED, failing `tsc`. So this guards the whole
// value proposition: after `.use(authed(...))` the route registry + context stay precisely typed.
server()
  .use(authed(plainAuth))
  .get("/probe", (c) => {
    // @ts-expect-error `principal` has no `nope` field - it is typed, not `any`.
    void c.principal.nope
    // Without requireTenant, tenantId is optional (string | undefined), so a bare string assign errors.
    // @ts-expect-error tenantId is `string | undefined` here, not `string`.
    const _t: string = c.principal.tenantId
    void _t
    return { id: c.principal.userId }
  })
