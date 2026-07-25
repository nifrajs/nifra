import { describe, expect, test } from "bun:test"
import {
  defineAssuranceConfig,
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

/**
 * Matching a rule on what a route DOES, not where it lives.
 *
 * A path glob is the wrong tool for "anything that writes to the database must be authenticated": it
 * breaks the moment a route moves, and it cannot see a route that acquired the capability later. The
 * declared tokens already reach reflection, so a policy can be written against them directly.
 */
describe("capability selector", () => {
  const app = server()
    .post("/orders", { capabilities: ["db.write"] }, () => ({ ok: true }))
    .get("/orders", { capabilities: ["db.read"] }, () => ({ items: [] }))
    .get("/health", () => ({ ok: true }))

  const report = evaluateRouteAssurance(app, {
    rules: [
      {
        name: "writes",
        match: { capabilities: ["db.write"] },
        require: [NIFRA_ASSURANCE.AUTHENTICATED],
      },
      { name: "rest", match: {}, require: [] },
    ],
  })

  test("classifies only the routes declaring the capability", () => {
    const ruleOf = (path: string, method: string): string | undefined =>
      report.routes.find((r) => r.path === path && r.method === method)?.rule
    expect(ruleOf("/orders", "POST")).toBe("writes")
    expect(ruleOf("/orders", "GET")).toBe("rest")
    expect(ruleOf("/health", "GET")).toBe("rest")
  })

  test("an unauthenticated write is a finding; a read is not", () => {
    const flagged = report.findings.map((f) => `${f.method} ${f.path}`)
    expect(flagged).toContain("POST /orders")
    expect(flagged).not.toContain("GET /orders")
  })

  test("matches when the route declares ANY of the listed tokens", () => {
    const many = evaluateRouteAssurance(app, {
      rules: [
        { name: "touches-db", match: { capabilities: ["db.read", "db.write"] }, require: [] },
        { name: "rest", match: {}, require: [] },
      ],
    })
    const rules = many.routes.map((r) => r.rule)
    expect(rules.filter((r) => r === "touches-db")).toHaveLength(2)
  })

  test("an empty capabilities selector is refused rather than matching nothing silently", () => {
    expect(() =>
      defineAssurancePolicy({ rules: [{ name: "x", match: { capabilities: [] }, require: [] }] }),
    ).toThrow(/non-empty/)
  })
})

/**
 * Naming exact tokens is precise but closed: a rule listing `db.write` does not cover `storage.write`,
 * so every policy has to enumerate every write token and a capability added later escapes the rule in
 * silence - the same fail-open shape as a misspelled selector key, arrived at by a different road.
 *
 * `access`/`zone` are keyed on what the capability IS. The test that matters here is the negative
 * control: a token the rule has never heard of is still caught.
 */
describe("access-class selector", () => {
  const definitions = [
    { id: "db.read", zone: "domain", access: "read" },
    { id: "db.write", zone: "domain", access: "write" },
    { id: "audit.write", zone: "operational", access: "write" },
  ] as const

  const evaluate = (
    source: unknown,
    rules: Parameters<typeof defineAssurancePolicy>[0]["rules"],
  ): ReturnType<typeof evaluateRouteAssurance> =>
    evaluateRouteAssurance(source, { rules }, { definitions })

  const ruleOf = (
    report: ReturnType<typeof evaluateRouteAssurance>,
    method: string,
    path: string,
  ): string | undefined => report.routes.find((r) => r.method === method && r.path === path)?.rule

  const WRITES = [
    {
      name: "authenticated-write",
      match: { access: "write", zone: "domain" },
      require: [NIFRA_ASSURANCE.AUTHENTICATED],
    },
    { name: "rest", match: {}, require: [] },
  ] as const

  test("matches a domain write and leaves a read alone", () => {
    const app = server()
      .post("/orders", { capabilities: ["db.write"] }, () => ({ ok: true }))
      .get("/orders", { capabilities: ["db.read"] }, () => ({ items: [] }))
      .get("/health", () => ({ ok: true }))
    const report = evaluate(app, [...WRITES])
    expect(ruleOf(report, "POST", "/orders")).toBe("authenticated-write")
    expect(ruleOf(report, "GET", "/orders")).toBe("rest")
    expect(ruleOf(report, "GET", "/health")).toBe("rest")
    expect(report.findings.map((f) => `${f.method} ${f.path}`)).toEqual(["POST /orders"])
  })

  test("catches a write token the rule never names", () => {
    // The whole point. `payments.charge` did not exist when the rule was written, and the rule is not
    // edited here - only the definitions the app already has to maintain for `nifra check`.
    const app = server().post("/charge", { capabilities: ["payments.charge"] }, () => ({
      ok: true,
    }))
    const report = evaluateRouteAssurance(
      app,
      { rules: [...WRITES] },
      { definitions: [...definitions, { id: "payments.charge", zone: "domain", access: "write" }] },
    )
    expect(ruleOf(report, "POST", "/charge")).toBe("authenticated-write")
    expect(report.ok).toBe(false)

    // Contrast: the exact-token selector this replaces does not see it at all.
    const byToken = evaluateRouteAssurance(app, {
      rules: [
        {
          name: "writes",
          match: { capabilities: ["db.write"] },
          require: [NIFRA_ASSURANCE.AUTHENTICATED],
        },
        { name: "rest", match: {}, require: [] },
      ],
    })
    expect(ruleOf(byToken, "POST", "/charge")).toBe("rest")
    expect(byToken.ok).toBe(true)
  })

  test("zone separates a business write from an operational one", () => {
    const app = server().post("/log", { capabilities: ["audit.write"] }, () => ({ ok: true }))
    expect(ruleOf(evaluate(app, [...WRITES]), "POST", "/log")).toBe("rest")
    expect(
      ruleOf(
        evaluate(app, [{ name: "any-write", match: { access: "write" }, require: [] }]),
        "POST",
        "/log",
      ),
    ).toBe("any-write")
  })

  test("access and zone must hold for the SAME capability", () => {
    // A route that reads business state and writes an audit log satisfies "domain" and "write"
    // separately. Combining halves of two different tokens would make the rule claim a business write
    // that never happens - and, worse, would match routes the policy author did not intend.
    const app = server().post("/report", { capabilities: ["db.read", "audit.write"] }, () => ({
      ok: true,
    }))
    expect(ruleOf(evaluate(app, [...WRITES]), "POST", "/report")).toBe("rest")
  })

  test("a declared token with no definition does not silently satisfy the rule", () => {
    // It cannot match, so the route falls through - which is why `unknown-capability` from capability
    // assurance is the other half of this gate and both run in `nifra check`.
    const app = server().post("/typo", { capabilities: ["db.writ"] }, () => ({ ok: true }))
    expect(ruleOf(evaluate(app, [...WRITES]), "POST", "/typo")).toBe("rest")
  })
})

/**
 * A class selector resolves through the capability definitions. With none supplied it can only match
 * nothing - and a rule that matches nothing does not fail, it lets the route fall past to whatever
 * laxer rule comes next. So the config is refused instead of shipping with its strictest rule inert.
 */
describe("class selector without definitions", () => {
  const rules = [
    {
      name: "writes",
      match: { access: "write" as const },
      require: [NIFRA_ASSURANCE.AUTHENTICATED],
    },
  ]

  test("the policy alone still validates - it is the evaluation that needs definitions", () => {
    expect(() => defineAssurancePolicy({ rules })).not.toThrow()
  })

  test("evaluating without definitions throws rather than matching nothing", () => {
    const app = server().post("/orders", { capabilities: ["db.write"] }, () => ({ ok: true }))
    expect(() => evaluateRouteAssurance(app, { rules })).toThrow(/no capability definitions/)
  })

  test("a config using the selector without a capabilities policy is refused", () => {
    const app = server().post("/orders", { capabilities: ["db.write"] }, () => ({ ok: true }))
    expect(() => defineAssuranceConfig({ source: app, policy: { rules } })).toThrow(
      /needs capability definitions/,
    )
  })

  test("the same config is accepted once the definitions exist", () => {
    const app = server().post("/orders", { capabilities: ["db.write"] }, () => ({ ok: true }))
    expect(() =>
      defineAssuranceConfig({
        source: app,
        policy: { rules: [...rules, { name: "rest", match: {}, require: [] }] },
        capabilities: {
          definitions: [{ id: "db.write", zone: "domain", access: "write" }],
          provenance: { imports: [], forbiddenImports: [] },
        },
      }),
    ).not.toThrow()
  })

  test("a policy with no class selector is unaffected by absent definitions", () => {
    const app = server().post("/orders", { capabilities: ["db.write"] }, () => ({ ok: true }))
    expect(
      evaluateRouteAssurance(app, {
        rules: [{ name: "writes", match: { capabilities: ["db.write"] }, require: [] }],
      }).ok,
    ).toBe(true)
  })

  test("an invalid access or zone value is refused", () => {
    expect(() =>
      defineAssurancePolicy({
        rules: [{ name: "x", match: { access: "delete" } as never, require: [] }],
      }),
    ).toThrow(/access selector/)
    expect(() =>
      defineAssurancePolicy({
        rules: [{ name: "x", match: { zone: "infra" } as never, require: [] }],
      }),
    ).toThrow(/zone selector/)
  })
})

/**
 * The selector is rebuilt from an allowlist of known keys, so anything unrecognised used to be dropped
 * in silence - and a selector that loses its only constraint matches EVERY route, so the rule swallows
 * everything after it. In a policy whose first rule is the lenient one, a single typo disables the rest
 * of the file. That is a fail-open in a security policy, so it is refused.
 */
describe("unknown selector keys", () => {
  test("a misspelled selector key is an error, not a rule that matches everything", () => {
    expect(() =>
      defineAssurancePolicy({
        rules: [{ name: "typo", match: { capabilites: ["db.write"] } as never, require: [] }],
      }),
    ).toThrow(/unknown selector key/)
  })

  test("the known keys are all still accepted", () => {
    expect(() =>
      defineAssurancePolicy({
        rules: [
          {
            name: "ok",
            match: {
              methods: ["POST"],
              paths: ["/a/**"],
              tools: false,
              capabilities: ["db.write"],
            },
            require: [],
          },
        ],
      }),
    ).not.toThrow()
  })
})
