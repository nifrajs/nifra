import { describe, expect, test } from "bun:test"
import {
  defineAssurancePolicy,
  evaluateRouteAssurance,
  NIFRA_ASSURANCE,
  withRouteAssurance,
} from "../src/assurance.ts"
import { defineIdentityPlugin, definePlugin, type Middleware, server } from "../src/index.ts"

const evidence = (app: { routes(): readonly unknown[] }, path: string): readonly string[] => {
  const route = app
    .routes()
    .find((candidate) =>
      typeof candidate === "object" && candidate !== null && "path" in candidate
        ? candidate.path === path
        : false,
    ) as { assurance?: readonly { id: string }[] } | undefined
  return route?.assurance?.map((item) => item.id) ?? []
}

describe("route assurance evidence", () => {
  test("handler evidence is route-local and invalid scopes fail before registration", () => {
    const local = withRouteAssurance(() => ({ ok: true }), {
      id: "test.command",
      source: "command",
      scope: "plugin",
    })
    const app = server().post("/command", local)
    expect(evidence(app, "/command")).toEqual(["test.command"])

    const invalid = withRouteAssurance(() => ({ ok: true }), {
      id: "test.invalid",
      source: "invalid",
      scope: "global",
    })
    expect(() => app.post("/invalid", invalid)).toThrow("handler assurance")
    expect(app.routes().some((route) => route.path === "/invalid")).toBe(false)
  })

  test("global evidence covers routes registered before and after use, filtered by method", () => {
    const mutationGuard = withRouteAssurance<Middleware>(
      { name: "mutation-guard", onRequest: () => undefined },
      {
        id: "test.mutation-guard",
        source: "mutation-guard",
        scope: "global",
        methods: ["POST"],
      },
    )
    const app = server()
      .post("/before", () => ({ ok: true }))
      .get("/read", () => ({ ok: true }))
      .use(mutationGuard)
      .post("/after", () => ({ ok: true }))

    expect(evidence(app, "/before")).toEqual(["test.mutation-guard"])
    expect(evidence(app, "/after")).toEqual(["test.mutation-guard"])
    expect(evidence(app, "/read")).toEqual([])
  })

  test("subsequent evidence follows Nifra's order-scoped hook semantics", () => {
    const auth = withRouteAssurance(
      definePlugin("test-auth", (app) => app.beforeHandle(() => undefined)),
      { id: "test.authenticated", source: "test-auth", scope: "subsequent" },
    )
    const app = server()
      .get("/public", () => ({ ok: true }))
      .use(auth)
      .get("/private", () => ({ ok: true }))

    expect(evidence(app, "/public")).toEqual([])
    expect(evidence(app, "/private")).toEqual(["test.authenticated"])
  })

  test("plugin evidence covers only routes registered by that plugin", () => {
    const adminRoutes = withRouteAssurance(
      defineIdentityPlugin("admin-routes", (app) => {
        app.get("/admin/health", () => ({ ok: true }))
        app.post("/admin/retry", () => ({ ok: true }))
        return app
      }),
      [
        { id: "test.admin", source: "admin-routes", scope: "plugin" },
        {
          id: "test.csrf",
          source: "admin-routes",
          scope: "plugin",
          methods: ["POST"],
        },
      ],
    )
    const app = server()
      .get("/before", () => ({ ok: true }))
      .use(adminRoutes)
      .get("/after", () => ({ ok: true }))

    expect(evidence(app, "/before")).toEqual([])
    expect(evidence(app, "/admin/health")).toEqual(["test.admin"])
    expect(evidence(app, "/admin/retry")).toEqual(["test.admin", "test.csrf"])
    expect(evidence(app, "/after")).toEqual([])
  })

  test("a schema-validated body publishes the core read-time body bound", () => {
    const body = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value: unknown) => ({ value }),
      },
    } as never
    const app = server().post("/schema", { body }, (context) => context.body)
    expect(evidence(app, "/schema")).toEqual(["nifra.body-bounded"])
    expect(app.routes()[0]?.assurance?.[0]?.source).toBe("route-schema")
  })

  test("merged global evidence follows merged global hook semantics", () => {
    const global = withRouteAssurance<Middleware>(
      { name: "global", onRequest: () => undefined },
      { id: "test.global", source: "global", scope: "global" },
    )
    const group = server()
      .use(global)
      .get("/group", () => ({ ok: true }))
    const app = server()
      .get("/own", () => ({ ok: true }))
      .merge(group)

    expect(evidence(app, "/own")).toEqual(["test.global"])
    expect(evidence(app, "/group")).toEqual(["test.global"])
  })
})

describe("route assurance policy", () => {
  const policy = defineAssurancePolicy({
    rules: [
      { name: "health", match: { paths: ["/health"] }, require: [] },
      {
        name: "webhooks",
        match: { methods: ["POST"], paths: ["/webhooks/**"] },
        require: ["test.signature", "test.rate-limit"],
        forbid: ["test.browser-session"],
      },
      {
        name: "mutations",
        match: { methods: ["POST", "PUT", "PATCH", "DELETE"] },
        require: ["test.authenticated", "test.rate-limit"],
      },
      { name: "reads", match: { methods: ["GET", "HEAD"] }, require: ["test.authenticated"] },
    ],
  })

  test("first matching rule classifies a route and reports missing/forbidden evidence", () => {
    const guard = withRouteAssurance<Middleware>({ name: "guards", onRequest: () => undefined }, [
      { id: "test.rate-limit", source: "guards", scope: "global" },
      { id: "test.browser-session", source: "guards", scope: "global" },
    ])
    const signature = withRouteAssurance<Middleware>(
      { name: "signature", onRequest: () => undefined },
      {
        id: "test.signature",
        source: "signature",
        scope: "global",
        paths: ["/webhooks/**"],
      },
    )
    const app = server()
      .use(guard)
      .use(signature)
      .post("/webhooks/stripe", () => ({ ok: true }))
      .post("/orders", () => ({ ok: true }))
      .get("/health", () => ({ ok: true }))
      .get("/orders/:id", () => ({ ok: true }))

    const report = evaluateRouteAssurance(app, policy)
    expect(report.ok).toBe(false)
    expect(report.routes.find((route) => route.path === "/webhooks/stripe")?.rule).toBe("webhooks")
    expect(report.findings).toEqual([
      expect.objectContaining({
        code: "forbidden-evidence",
        method: "POST",
        path: "/webhooks/stripe",
        evidence: "test.browser-session",
      }),
      expect.objectContaining({
        code: "missing-evidence",
        method: "POST",
        path: "/orders",
        evidence: "test.authenticated",
      }),
      expect.objectContaining({
        code: "missing-evidence",
        method: "GET",
        path: "/orders/:id",
        evidence: "test.authenticated",
      }),
    ])
  })

  test("unmatched routes fail closed by default and may be ignored explicitly", () => {
    const app = server().get("/probe", () => ({ ok: true }))
    const narrow = defineAssurancePolicy({
      rules: [{ name: "health only", match: { paths: ["/health"] }, require: [] }],
    })
    expect(evaluateRouteAssurance(app, narrow).findings[0]).toMatchObject({
      code: "unclassified-route",
      method: "GET",
      path: "/probe",
    })

    const permissive = defineAssurancePolicy({ rules: [], unmatched: "ignore" })
    expect(evaluateRouteAssurance(app, permissive)).toMatchObject({ ok: true, findings: [] })
  })

  test("an empty reflection source fails closed unless explicitly allowed", () => {
    expect(evaluateRouteAssurance({}, { rules: [] }).findings[0]).toMatchObject({
      code: "no-routes",
    })
    expect(evaluateRouteAssurance({}, { rules: [], allowEmpty: true }).ok).toBe(true)
  })

  test("policy construction validates names, evidence ids, methods, and globs", () => {
    expect(() => defineAssurancePolicy({ rules: [{ name: "", match: {} }] })).toThrow()
    expect(() =>
      defineAssurancePolicy({
        rules: [{ name: "bad", match: { methods: ["NOPE" as never] }, require: [] }],
      }),
    ).toThrow()
    expect(() =>
      defineAssurancePolicy({
        rules: [{ name: "bad", match: { paths: ["relative/**"] }, require: [] }],
      }),
    ).toThrow()
    expect(() =>
      defineAssurancePolicy({
        rules: [{ name: "bad", match: {}, require: ["has spaces"] }],
      }),
    ).toThrow()
    expect(() =>
      defineAssurancePolicy({
        rules: [{ name: "same", match: {}, require: ["test.guard"], forbid: ["test.guard"] }],
      }),
    ).toThrow("both requires and forbids")
    expect(() =>
      defineAssurancePolicy({
        rules: [
          { name: "trimmed", match: {} },
          { name: " trimmed ", match: {} },
        ],
      }),
    ).toThrow("duplicate rule")
    expect(() =>
      withRouteAssurance({}, { id: "has spaces", source: "guard", scope: "global" }),
    ).toThrow("invalid evidence id")
    expect(() =>
      withRouteAssurance({}, { id: "test.guard", source: " ", scope: "global" }),
    ).toThrow("source")
    expect(() =>
      withRouteAssurance({}, { id: "test.guard", source: "guard", scope: "invalid" as never }),
    ).toThrow("invalid scope")
    expect(() =>
      withRouteAssurance(
        {},
        {
          id: "test.guard",
          source: "guard",
          scope: "global",
          methods: ["NOPE" as never],
        },
      ),
    ).toThrow("unsupported HTTP method")
    expect(() =>
      withRouteAssurance(
        {},
        {
          id: "test.guard",
          source: "guard",
          scope: "global",
          paths: ["/bad/**/tail"],
        },
      ),
    ).toThrow("final path segment")
    expect(() =>
      withRouteAssurance(
        {},
        {
          id: "test.guard",
          source: "guard",
          scope: "global",
          paths: ["/bad*"],
        },
      ),
    ).toThrow("whole path segment")
  })
})

describe("inline route assurance (schema.assurance) - in-handler-guarded routes emit evidence", () => {
  test("a declared evidence id reflects as route-scoped `declared` evidence, satisfying a require rule", () => {
    // The route guards auth INSIDE the handler (invisible to reflection) but declares the evidence inline -
    // no `withRouteAssurance` middleware rewrite needed.
    const app = server().get("/admin", { assurance: [NIFRA_ASSURANCE.AUTHENTICATED] }, () => ({
      ok: true,
    }))
    expect(evidence(app, "/admin")).toEqual([NIFRA_ASSURANCE.AUTHENTICATED])
    const declared = (
      app.routes().find((r) => (r as { path?: string }).path === "/admin") as {
        assurance?: readonly { id: string; source: string }[]
      }
    ).assurance
    expect(declared?.[0]).toEqual({ id: NIFRA_ASSURANCE.AUTHENTICATED, source: "declared" })

    const policy = defineAssurancePolicy({
      rules: [
        { name: "admin", match: { paths: ["/admin"] }, require: [NIFRA_ASSURANCE.AUTHENTICATED] },
      ],
    })
    expect(evaluateRouteAssurance(app, policy)).toMatchObject({ ok: true, findings: [] })
  })

  test("an invalid inline evidence id fails closed at registration", () => {
    expect(() => server().get("/x", { assurance: ["NOT VALID"] }, () => null)).toThrow(
      "invalid evidence id",
    )
  })
})

describe("classified-no-evidence (opt-in visibility of the 'label without proof' gap)", () => {
  // A pure-classification rule (no require/forbid) - the shape a classification-only policy degrades to.
  const classifyOnly = { name: "reads", match: { paths: ["/data/**"] } }

  test("opt-in flag surfaces a classified route that carries no evidence", () => {
    const app = server().get("/data/x", () => ({ ok: true }))
    const report = evaluateRouteAssurance(app, {
      rules: [classifyOnly],
      flagClassifiedWithoutEvidence: true,
    })
    expect(report.ok).toBe(false)
    expect(report.findings).toEqual([
      expect.objectContaining({ code: "classified-no-evidence", path: "/data/x", rule: "reads" }),
    ])
  })

  test("without the flag (default), the same route passes silently - back-compatible", () => {
    const app = server().get("/data/x", () => ({ ok: true }))
    expect(evaluateRouteAssurance(app, { rules: [classifyOnly] })).toMatchObject({
      ok: true,
      findings: [],
    })
  })

  test("a route that DECLARES evidence is not flagged", () => {
    const app = server().get("/data/x", { assurance: [NIFRA_ASSURANCE.AUTHENTICATED] }, () => ({
      ok: true,
    }))
    expect(
      evaluateRouteAssurance(app, { rules: [classifyOnly], flagClassifiedWithoutEvidence: true }),
    ).toMatchObject({ ok: true, findings: [] })
  })

  test("a forbid-bearing rule (public route, no evidence expected) is not flagged", () => {
    const app = server().get("/data/x", () => ({ ok: true }))
    const report = evaluateRouteAssurance(app, {
      rules: [
        { name: "public", match: { paths: ["/data/**"] }, forbid: [NIFRA_ASSURANCE.AUTHENTICATED] },
      ],
      flagClassifiedWithoutEvidence: true,
    })
    expect(report).toMatchObject({ ok: true, findings: [] })
  })
})
