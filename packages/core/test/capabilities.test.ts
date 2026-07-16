import { describe, expect, test } from "bun:test"
import { NIFRA_ASSURANCE, withRouteAssurance } from "../src/assurance.ts"
import {
  declaredCapabilities,
  defineCapabilityPolicy,
  evaluateCapabilityAssurance,
  snapshotCapabilities,
  useCapability,
} from "../src/capabilities.ts"
import { server } from "../src/index.ts"
import { defineContract, implement } from "../src/server/contract.ts"

const policy = defineCapabilityPolicy({
  definitions: [
    { id: "db.read", zone: "domain", access: "read" },
    { id: "db.write", zone: "domain", access: "write", idempotency: "request" },
    {
      id: "payments.charge",
      zone: "domain",
      access: "write",
      idempotency: "durable",
    },
    { id: "telemetry.write", zone: "operational", access: "write" },
  ],
  provenance: { imports: [], forbiddenImports: [] },
})

describe("route capabilities", () => {
  test("reflects normalized declarations and denies an undeclared runtime effect", async () => {
    const observed: unknown[] = []
    const app = server({ onCapabilityUse: (event) => observed.push(event) }).post(
      "/orders",
      { capabilities: ["db.write", "db.write"] },
      (c) => {
        expect(declaredCapabilities(c)).toEqual(["db.write"])
        useCapability(c, "db.write")
        expect(() => useCapability(c, "payments.charge")).toThrow("not declared")
        return { ok: true }
      },
    )

    expect(app.routes()[0]?.capabilities).toEqual(["db.write"])
    expect(
      (await app.fetch(new Request("http://nifra.test/orders", { method: "POST" }))).status,
    ).toBe(200)
    expect(observed).toEqual([{ capability: "db.write", method: "POST", path: "/orders" }])
  })

  test("a beacon on an unclassified route fails closed", async () => {
    const app = server().post("/unsafe", (c) => {
      useCapability(c, "db.write")
      return { ok: true }
    })
    expect(
      (await app.fetch(new Request("http://nifra.test/unsafe", { method: "POST" }))).status,
    ).toBe(500)
  })

  test("contract implementation preserves capability declarations", () => {
    const contract = defineContract({
      list: { method: "GET", path: "/orders", capabilities: ["db.read"] },
    } as const)
    const app = implement(contract, { list: () => [] })
    expect(app.routes()[0]?.capabilities).toEqual(["db.read"])
  })
})

describe("capability assurance", () => {
  test("policy construction rejects ambiguous or malformed security policy", () => {
    expect(() => defineCapabilityPolicy({ definitions: [] } as never)).toThrow("provenance")
    const make = (definition: unknown) =>
      defineCapabilityPolicy({
        definitions: [definition] as never,
        provenance: { imports: [], forbiddenImports: [] },
      })
    expect(() => make({ id: "Not Valid", zone: "domain", access: "read" })).toThrow("invalid")
    expect(() =>
      defineCapabilityPolicy({
        definitions: [
          { id: "db.read", zone: "domain", access: "read" },
          { id: "db.read", zone: "domain", access: "read" },
        ],
        provenance: { imports: [], forbiddenImports: [] },
      }),
    ).toThrow("duplicate")
    expect(() => make({ id: "x.read", zone: "invalid", access: "read" })).toThrow("zone")
    expect(() => make({ id: "x.read", zone: "domain", access: "invalid" })).toThrow("access")
    expect(() =>
      make({ id: "x.read", zone: "domain", access: "read", idempotency: "request" }),
    ).toThrow("cannot require")
    expect(() =>
      defineCapabilityPolicy({
        definitions: [{ id: "db.read", zone: "domain", access: "read" }],
        provenance: {
          imports: [{ specifier: "bad\nmodule", capabilities: ["db.read"] }],
          forbiddenImports: [],
        },
      }),
    ).toThrow("specifier")
    expect(() =>
      defineCapabilityPolicy({
        definitions: [{ id: "db.read", zone: "domain", access: "read" }],
        provenance: {
          imports: [{ specifier: "@app/db", capabilities: ["db.write"] }],
          forbiddenImports: [],
        },
      }),
    ).toThrow("unknown")
    expect(() =>
      defineCapabilityPolicy({
        definitions: [],
        provenance: {
          imports: [],
          forbiddenImports: [{ specifier: "pg", reason: " " }],
        },
      }),
    ).toThrow("reason")
    expect(() =>
      defineCapabilityPolicy({
        definitions: [],
        provenance: {
          imports: [],
          forbiddenImports: [],
          routeModules: [{ match: {}, modules: [] }],
        },
      }),
    ).toThrow("module")
  })

  test("finds evidence beyond declarations and safe-method domain writes", () => {
    const app = server()
      .get("/bad", { capabilities: ["db.write", "telemetry.write"] }, () => ({ ok: true }))
      .get("/read", { capabilities: ["db.read"] }, () => ({ ok: true }))
    const report = evaluateCapabilityAssurance(app, policy, {
      routes: [
        {
          method: "GET",
          path: "/read",
          covered: true,
          evidence: [{ id: "db.write", kind: "static", source: "app-db" }],
        },
        { method: "GET", path: "/bad", covered: true, evidence: [] },
      ],
    })

    expect(report.findings.map((finding) => finding.code)).toEqual([
      "safe-method-domain-write",
      "missing-request-idempotency",
      "undeclared-capability-evidence",
      "safe-method-domain-write",
      "missing-request-idempotency",
    ])
    expect(report.routes.find((route) => route.path === "/read")?.unproven).toEqual(["db.read"])
  })

  test("requires effect-specific request and durable command evidence", () => {
    const idempotent = withRouteAssurance((c: unknown) => c, {
      id: NIFRA_ASSURANCE.IDEMPOTENCY_KEY,
      source: "test-idempotency",
      scope: "plugin",
    })
    const durable = withRouteAssurance((c: unknown) => c, {
      id: NIFRA_ASSURANCE.DURABLE_COMMAND,
      source: "test-command",
      scope: "plugin",
    })
    const app = server()
      .post("/db", { capabilities: ["db.write"] }, idempotent as never)
      .post("/charge", { capabilities: ["payments.charge"] }, durable as never)
    const report = evaluateCapabilityAssurance(app, policy, {
      routes: [
        {
          method: "POST",
          path: "/db",
          covered: true,
          evidence: [{ id: "db.write", kind: "static", source: "app-db" }],
        },
        {
          method: "POST",
          path: "/charge",
          covered: true,
          evidence: [{ id: "payments.charge", kind: "static", source: "app-billing" }],
        },
      ],
    })
    expect(report).toMatchObject({ ok: true, findings: [] })
  })

  test("fails closed for unknown declarations, missing coverage, and missing durable proof", () => {
    const app = server().post(
      "/charge",
      { capabilities: ["payments.charge", "unknown.effect"] },
      () => null,
    )
    const report = evaluateCapabilityAssurance(app, policy, { routes: [] })
    expect(report.findings.map((finding) => finding.code)).toEqual([
      "unknown-capability",
      "provenance-uncovered",
      "missing-durable-idempotency",
    ])
  })

  test("runtime input validation rejects malformed tokens", () => {
    expect(() => useCapability({}, "Not Valid")).toThrow("invalid runtime capability")
  })

  test("snapshots are deterministic and contain tokens only", () => {
    const app = server()
      .post("/z", { capabilities: ["db.write"] }, () => null)
      .get("/a", { capabilities: ["db.read"] }, () => null)
    const report = evaluateCapabilityAssurance(app, policy, {
      routes: [
        { method: "POST", path: "/z", covered: true, evidence: [] },
        { method: "GET", path: "/a", covered: true, evidence: [] },
      ],
    })
    expect(snapshotCapabilities(report)).toEqual({
      nifraCapabilities: 1,
      routes: [
        { method: "GET", path: "/a", declared: ["db.read"], evidenced: [], unproven: ["db.read"] },
        {
          method: "POST",
          path: "/z",
          declared: ["db.write"],
          evidenced: [],
          unproven: ["db.write"],
        },
      ],
    })
  })
})
