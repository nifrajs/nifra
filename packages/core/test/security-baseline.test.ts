import { describe, expect, test } from "bun:test"
import {
  type AssuranceRouteSelector,
  evaluateRouteAssurance,
  matchesAssuranceSelector,
  NIFRA_ASSURANCE,
  withRouteAssurance,
} from "../src/assurance.ts"
import { type Middleware, server } from "../src/index.ts"
import type { ReflectedRoute, SchemaReflection } from "../src/reflection.ts"
import type { StandardSchemaV1, StandardTypes } from "../src/schema/standard.ts"
import { securityBaseline } from "../src/security/baseline.ts"
import { method } from "../src/server/methods.ts"

const bodySchema: StandardSchemaV1<unknown, { name: string }> = {
  "~standard": {
    version: 1,
    vendor: "baseline-test",
    validate: (value: unknown) => ({ value: value as { name: string } }),
    types: undefined as unknown as StandardTypes<unknown, { name: string }>,
  },
}

const BODY: SchemaReflection = { standard: bodySchema, jsonSchema: undefined, fields: undefined }

/** Minimal reflected route for direct selector unit tests. */
const route = (over: Partial<ReflectedRoute>): ReflectedRoute => ({
  method: "POST",
  path: "/x",
  ...over,
})

describe("hasBody / bodyLimit selectors", () => {
  test("hasBody matches only routes that declare a body schema", () => {
    const withBody = route({ schema: { body: BODY } })
    const bodyless = route({ schema: {} })
    expect(matchesAssuranceSelector(withBody, { hasBody: true })).toBe(true)
    expect(matchesAssuranceSelector(bodyless, { hasBody: true })).toBe(false)
    expect(matchesAssuranceSelector(bodyless, { hasBody: false })).toBe(true)
  })

  test("bodyLimit distinguishes bounded, unlimited, and unset", () => {
    const bounded = route({ schema: { body: BODY, bodyLimit: 1024 } })
    const unlimited = route({ schema: { body: BODY, bodyLimit: "unlimited" } })
    const unset = route({ schema: { body: BODY } })
    expect(matchesAssuranceSelector(bounded, { bodyLimit: "bounded" })).toBe(true)
    expect(matchesAssuranceSelector(unlimited, { bodyLimit: "unlimited" })).toBe(true)
    expect(matchesAssuranceSelector(unset, { bodyLimit: "unset" })).toBe(true)
    expect(matchesAssuranceSelector(bounded, { bodyLimit: "unlimited" })).toBe(false)
  })
})

describe("securityBaseline preset", () => {
  test("every level is accepted by the engine's own policy validator", () => {
    // evaluate() runs defineAssurancePolicy internally; a malformed preset would throw here.
    for (const level of ["essential", "standard", "strict"] as const) {
      expect(() =>
        evaluateRouteAssurance([], { ...securityBaseline({ level }), allowEmpty: true }),
      ).not.toThrow()
    }
    expect(securityBaseline({ unmatched: "error" }).unmatched).toBe("error")
  })

  test("the level ladder only widens: essential < standard, standard == strict rule count", () => {
    // standard/strict add the sensitive-* rules; strict widens bundles rather than adding rules.
    expect(securityBaseline({ level: "essential" }).rules.length).toBeLessThan(
      securityBaseline({ level: "standard" }).rules.length,
    )
    expect(securityBaseline({ level: "strict" }).rules).toHaveLength(
      securityBaseline({ level: "standard" }).rules.length,
    )
  })

  test("a normal bounded-body POST auto-satisfies the standard baseline", () => {
    // No auth evidence, so CSRF is not demanded; body-bounded is core-published from the schema.
    const app = server().post("/signup", { body: bodySchema }, () => ({ ok: true }))
    expect(evaluateRouteAssurance(app, securityBaseline())).toMatchObject({
      ok: true,
      findings: [],
    })
  })

  test("strict additionally demands a response contract and rate limit on that same POST", () => {
    const app = server().post("/signup", { body: bodySchema }, () => ({ ok: true }))
    const report = evaluateRouteAssurance(app, securityBaseline({ level: "strict" }))
    expect(report.ok).toBe(false)
    expect(report.findings).toContainEqual(
      expect.objectContaining({ rule: "mutation-body", evidence: NIFRA_ASSURANCE.RATE_LIMITED }),
    )
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        rule: "mutation-body",
        evidence: NIFRA_ASSURANCE.RESPONSE_CONTRACT,
      }),
    )
  })

  test("an author-declared body-bounded label is rejected - runtime proof is required", () => {
    const declared = [
      {
        method: "POST",
        path: "/signup",
        schema: { body: bodySchema },
        assurance: [{ id: NIFRA_ASSURANCE.BODY_BOUNDED, source: "declared" }],
      },
    ]
    const report = evaluateRouteAssurance(declared, securityBaseline())
    expect(report.ok).toBe(false)
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: "missing-evidence",
        rule: "mutation-body",
        evidence: NIFRA_ASSURANCE.BODY_BOUNDED,
      }),
    )
  })

  test("a regressed unlimited-body schema route is banned (snapshot input)", () => {
    // Boot rejects this shape today; the gate proves a snapshot/manifest carrying it fails closed.
    const regressed = [
      {
        method: "POST",
        path: "/upload",
        schema: { body: bodySchema, bodyLimit: "unlimited" },
        assurance: [],
      },
    ]
    const report = evaluateRouteAssurance(regressed, securityBaseline())
    expect(report.ok).toBe(false)
    expect(report.findings).toContainEqual(
      expect.objectContaining({ rule: "banned-unlimited-body", code: "missing-evidence" }),
    )
  })
})

describe("custom methods under the baseline", () => {
  const sessionAuth = (): Middleware =>
    withRouteAssurance<Middleware>(
      { name: "session-auth", beforeHandle: () => undefined },
      { id: NIFRA_ASSURANCE.AUTHENTICATED, source: "session-auth", scope: "subsequent" },
    )

  test("an authenticated custom-method route must prove CSRF like a POST", () => {
    const app = server()
      .use(sessionAuth())
      .use(method("PURGE", "/cache", () => ({})))
    const report = evaluateRouteAssurance(app, securityBaseline({ level: "essential" }))
    expect(report.routes).toContainEqual(
      expect.objectContaining({ method: "PURGE", path: "/cache", rule: "mutation" }),
    )
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        method: "PURGE",
        rule: "mutation",
        code: "missing-evidence",
        evidence: NIFRA_ASSURANCE.CSRF,
      }),
    )
  })

  test("OPTIONS and WebSocket routes stay outside the mutation rules", () => {
    const authenticated = [{ id: NIFRA_ASSURANCE.AUTHENTICATED, source: "session-auth" }]
    const report = evaluateRouteAssurance(
      [
        { method: "OPTIONS", path: "/cache", assurance: authenticated },
        { method: "WS", path: "/live", assurance: authenticated },
      ],
      securityBaseline({ level: "essential" }),
    )
    expect(report.ok).toBe(true)
    expect(report.routes.map((entry) => entry.rule)).toEqual([undefined, undefined])
  })

  test("exceptMethods skips the methods it names and refuses a typo", () => {
    const selector: AssuranceRouteSelector = { exceptMethods: ["GET", "HEAD", "OPTIONS", "WS"] }
    expect(matchesAssuranceSelector(route({ method: "PURGE" }), selector)).toBe(true)
    expect(matchesAssuranceSelector(route({ method: "DELETE" }), selector)).toBe(true)
    expect(matchesAssuranceSelector(route({ method: "GET" }), selector)).toBe(false)
    expect(matchesAssuranceSelector(route({ method: "WS" }), selector)).toBe(false)
    expect(() =>
      evaluateRouteAssurance([route({})], {
        rules: [{ name: "typo", match: JSON.parse('{"exceptMethods":["GTE"]}') }],
      }),
    ).toThrow("unsupported HTTP method")
    expect(() =>
      evaluateRouteAssurance([route({})], {
        rules: [{ name: "empty", match: { exceptMethods: [] } }],
      }),
    ).toThrow("non-empty array")
  })
})
