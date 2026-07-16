import { describe, expect, test } from "bun:test"
import { RouteConfigError, type StandardSchemaV1, server } from "@nifrajs/core"
import {
  evaluateRouteAssurance,
  NIFRA_ASSURANCE,
  withRouteAssurance,
} from "@nifrajs/core/assurance"
import { defineContract, implement } from "@nifrajs/core/contract"

const passThrough: StandardSchemaV1 = {
  "~standard": { version: 1, vendor: "test", validate: (value) => ({ value }) },
}

describe("defineContract — validation (L2)", () => {
  test("returns the contract on valid input", () => {
    const c = defineContract({
      list: { method: "GET", path: "/users" },
      create: { method: "POST", path: "/users" },
    })
    expect(c.list.method).toBe("GET")
    expect(c.create.path).toBe("/users")
  })

  test("allows the same path with different methods", () => {
    expect(() =>
      defineContract({
        a: { method: "GET", path: "/x" },
        b: { method: "POST", path: "/x" },
      }),
    ).not.toThrow()
  })

  test("rejects an unsupported method", () => {
    // cast bypasses the compile-time guard to exercise the runtime check
    expect(() => defineContract({ x: { method: "BREW" as "GET", path: "/x" } })).toThrow(
      RouteConfigError,
    )
  })

  test("rejects a path without a leading slash", () => {
    try {
      defineContract({ x: { method: "GET", path: "no-slash" } })
      throw new Error("expected throw")
    } catch (err) {
      expect(err).toBeInstanceOf(RouteConfigError)
      expect((err as RouteConfigError).code).toBe("INVALID_PATH")
    }
  })

  test("rejects an empty path", () => {
    expect(() => defineContract({ x: { method: "GET", path: "" } })).toThrow(RouteConfigError)
  })

  test("rejects a duplicate (method, path) across operations", () => {
    try {
      defineContract({
        a: { method: "GET", path: "/dup" },
        b: { method: "GET", path: "/dup" },
      })
      throw new Error("expected throw")
    } catch (err) {
      expect((err as RouteConfigError).code).toBe("DUPLICATE_ROUTE")
    }
  })
})

describe("implement() — response contract on the descriptor", () => {
  test("carries a contract op's `response` onto the route schema (for OpenAPI / introspection)", () => {
    const contract = defineContract({
      getMe: { method: "GET", path: "/me", response: passThrough },
    })
    const app = implement(contract, { getMe: () => ({ id: "1" }) })
    // Same descriptor path as inline routes — toOpenAPI + `nifra context` read it from app.routes().
    expect(app.routes()[0]?.schema?.response).toBe(passThrough)
  })

  test("a response-less op still produces an undefined schema (byte-identical to before)", () => {
    const app = implement(defineContract({ ping: { method: "GET", path: "/ping" } }), {
      ping: () => ({ ok: true }),
    })
    // No body/query/response ⇒ no schema object at all ⇒ the sync fast path is preserved untouched.
    expect(app.routes()[0]?.schema).toBeUndefined()
  })
})

describe("implement(contract, handlers, app) - the middleware seam", () => {
  const contract = defineContract({ me: { method: "GET", path: "/me" } })
  const authPolicy = {
    rules: [
      {
        name: "authed",
        match: { paths: ["/me"] },
        require: [NIFRA_ASSURANCE.AUTHENTICATED],
      },
    ],
  }

  test("the host app's derive reaches the contract's handlers", async () => {
    const app = implement(
      contract,
      { me: (c) => ({ actor: c.actor }) },
      server().derive(() => ({ actor: "alice" })),
    )
    expect(await (await app.fetch(new Request("http://x/me"))).json()).toEqual({ actor: "alice" })
  })

  test("a derive applied AFTER implement does not reach them (chains are captured at registration)", async () => {
    const app = implement(contract, {
      me: (c) => ({ actor: (c as { actor?: string }).actor ?? "none" }),
    }).derive(() => ({ actor: "alice" }))
    expect(await (await app.fetch(new Request("http://x/me"))).json()).toEqual({ actor: "none" })
  })

  test("an assurance-declaring plugin installed on the app satisfies the policy", () => {
    const auth = withRouteAssurance((app: ReturnType<typeof server>) => app, {
      id: NIFRA_ASSURANCE.AUTHENTICATED,
      source: "test-auth",
      scope: "subsequent",
    })
    const app = implement(contract, { me: () => ({ ok: true }) }, server().use(auth))
    expect(evaluateRouteAssurance(app, authPolicy as never).ok).toBe(true)
  })

  test("without that plugin the same policy fails - evidence is never assumed", () => {
    const app = implement(contract, { me: () => ({ ok: true }) })
    expect(evaluateRouteAssurance(app, authPolicy as never).ok).toBe(false)
  })

  test("routes already on the host app are served alongside the contract's", async () => {
    const app = implement(
      contract,
      { me: () => ({ u: 1 }) },
      server().get("/health", () => ({ up: true })),
    )
    expect(await (await app.fetch(new Request("http://x/health"))).json()).toEqual({ up: true })
    expect(await (await app.fetch(new Request("http://x/me"))).json()).toEqual({ u: 1 })
  })

  test("the two-argument form is unchanged", async () => {
    const app = implement(contract, { me: () => ({ u: 2 }) })
    expect(await (await app.fetch(new Request("http://x/me"))).json()).toEqual({ u: 2 })
  })

  test("a failed batch leaves the supplied app unchanged", async () => {
    const host = server().get("/taken", () => ({ host: true }))
    const conflicting = defineContract({
      added: { method: "GET", path: "/added" },
      taken: { method: "GET", path: "/taken" },
    })

    expect(() =>
      implement(
        conflicting,
        {
          added: () => ({ ghost: true }),
          taken: () => ({ shadowed: true }),
        },
        host,
      ),
    ).toThrow(RouteConfigError)

    expect(host.routes().map(({ method, path }) => `${method} ${path}`)).toEqual(["GET /taken"])
    expect((await host.fetch(new Request("http://x/added"))).status).toBe(404)
  })
})
