import { describe, expect, test } from "bun:test"
import { NIFRA_ASSURANCE, withRouteAssurance } from "../src/assurance.ts"
import {
  declaredCapabilities,
  defineCapabilityPolicy,
  evaluateCapabilityAssurance,
  executeCapability,
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
  test("caps interceptor timeouts that JavaScript timers would wrap", async () => {
    const app = server()
      .aroundCapability(
        async (_event, next) => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          await next()
        },
        { timeoutMs: 2_147_483_648 },
      )
      .get("/", { capabilities: ["db.read"] }, async (c) =>
        executeCapability(c, "db.read", {}, async () => ({ ok: true })),
      )
    expect((await app.fetch(new Request("http://nifra.test/"))).status).toBe(200)
  })

  test("aroundCapability asynchronously admits each executeCapability call before the effect", async () => {
    const order: string[] = []
    const events: unknown[] = []
    const app = server()
      .aroundCapability(async (event, next) => {
        order.push("policy:before")
        events.push(event)
        await Promise.resolve()
        await next()
        order.push("policy:after")
      })
      .post("/orders", { capabilities: ["db.write"] }, async (c) => {
        await executeCapability(c, "db.write", { target: "repo:orders" }, async () => {
          order.push("effect")
        })
        return { ok: true }
      })

    expect(
      (await app.fetch(new Request("http://nifra.test/orders", { method: "POST" }))).status,
    ).toBe(200)
    expect(order).toEqual(["policy:before", "policy:after", "effect"])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      capability: "db.write",
      method: "POST",
      path: "/orders",
      target: "repo:orders",
    })
    expect(events[0]).not.toHaveProperty("context")
    expect(events[0]).not.toHaveProperty("request")
  })

  test("request cancellation aborts pending capability admission before the effect runs", async () => {
    let admissionAborted = false
    let executed = false
    const app = server({
      requestTimeoutMs: 5,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    })
      .aroundCapability(
        async ({ signal }) => {
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                admissionAborted = true
                resolve()
              },
              { once: true },
            )
          })
        },
        { timeoutMs: 1_000 },
      )
      .post("/orders", { capabilities: ["db.write"] }, async (c) => {
        await executeCapability(c, "db.write", {}, async () => {
          executed = true
        })
      })

    const response = await app.fetch(new Request("http://nifra.test/orders", { method: "POST" }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(response.status).toBe(503)
    expect(admissionAborted).toBe(true)
    expect(executed).toBe(false)
  })

  test("interceptor metadata is validated even when the effect ledger is not installed", async () => {
    let intercepted = false
    let executed = false
    const app = server({ logger: { debug() {}, info() {}, warn() {}, error() {} } })
      .aroundCapability(async (_event, next) => {
        intercepted = true
        await next()
      })
      .post("/orders", { capabilities: ["db.write"] }, async (c) => {
        await executeCapability(c, "db.write", { target: "bad\nmetadata" }, async () => {
          executed = true
        })
      })

    expect(
      (await app.fetch(new Request("http://nifra.test/orders", { method: "POST" }))).status,
    ).toBe(500)
    expect(intercepted).toBe(false)
    expect(executed).toBe(false)
  })

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
      // `/bad` DECLARES a domain write on a GET. That is an HTTP semantics error the developer wrote
      // on purpose, and "cannot carry" is the right thing to say about it.
      "safe-method-domain-write",
      "missing-request-idempotency",
      // `/read` only REACHES one. Different cause, different fix, one finding.
      "unconfined-write-reach",
      "missing-request-idempotency",
    ])
    expect(report.routes.find((route) => route.path === "/read")?.unproven).toEqual(["db.read"])
  })

  /**
   * Reach is computed from the module that registers a route, so a read endpoint sitting beside a write
   * seam has write powers in scope. Reporting that as "evidence exceeds its declaration" AND "a safe
   * method cannot carry a domain write" is a dead end: both are true, they ask for opposite things, and
   * neither names the fix, which is to confine the reach rather than to argue about the declaration.
   */
  describe("unconfined write reach", () => {
    const reaching = (method: "GET" | "POST", declared: readonly string[]) => {
      const app =
        method === "GET"
          ? server().get("/x", { capabilities: [...declared] }, () => ({ ok: true }))
          : server().post("/x", { capabilities: [...declared] }, () => ({ ok: true }))
      return evaluateCapabilityAssurance(app, policy, {
        routes: [
          {
            method,
            path: "/x",
            covered: true,
            evidence: [{ id: "db.write", kind: "static", source: "app-db" }],
          },
        ],
      })
    }

    test("replaces the contradictory pair with one finding that names the fix", () => {
      const codes = reaching("GET", []).findings.map((f) => f.code)
      expect(codes).toContain("unconfined-write-reach")
      expect(codes).not.toContain("undeclared-capability-evidence")
      expect(codes).not.toContain("safe-method-domain-write")

      const finding = reaching("GET", []).findings.find((f) => f.code === "unconfined-write-reach")
      expect(finding?.capability).toBe("db.write")
      expect(finding?.message).toMatch(/move the route or the effect/)
    })

    test("still fails the report - this is a rename, not an exemption", () => {
      expect(reaching("GET", []).ok).toBe(false)
    })

    test("an unsafe method reaching an undeclared write is unchanged", () => {
      // A POST can legitimately declare a domain write, so there is no dead end and nothing to reword:
      // the route really does just need to declare what it reaches.
      const codes = reaching("POST", []).findings.map((f) => f.code)
      expect(codes).toContain("undeclared-capability-evidence")
      expect(codes).not.toContain("unconfined-write-reach")
    })

    test("a GET that DECLARES the write is still told it cannot carry one", () => {
      const codes = reaching("GET", ["db.write"]).findings.map((f) => f.code)
      expect(codes).toContain("safe-method-domain-write")
      expect(codes).not.toContain("unconfined-write-reach")
    })

    test("a GET reaching an undeclared READ is unaffected", () => {
      const app = server().get("/x", () => ({ ok: true }))
      const codes = evaluateCapabilityAssurance(app, policy, {
        routes: [
          {
            method: "GET",
            path: "/x",
            covered: true,
            evidence: [{ id: "db.read", kind: "static", source: "app-db" }],
          },
        ],
      }).findings.map((f) => f.code)
      expect(codes).toContain("undeclared-capability-evidence")
      expect(codes).not.toContain("unconfined-write-reach")
    })
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
