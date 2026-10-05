import { describe, expect, test } from "bun:test"
import { type StandardSchemaV1, server, status } from "@nifrajs/core"
import { t } from "@nifrajs/schema"
import {
  AdversarialContractError,
  assertAdversarialContract,
  runAdversarialContract,
} from "../src/index.ts"

describe("contract laboratory", () => {
  test("auth-context witnesses validate guard responses against status-specific contracts", async () => {
    const app = server()
      .use({
        name: "auth-guard",
        beforeHandle: (context) =>
          context.req.headers.get("authorization") === "Bearer test"
            ? undefined
            : status(401, { error: "unauthorized" }),
      })
      .get(
        "/private",
        {
          response: t.object({ ok: t.boolean() }),
          errors: { 401: t.object({ error: t.string() }) },
        },
        () => ({ ok: true }),
      )
    const seen: string[] = []
    const prepare = (request: Request, context: { auth?: "authenticated" | "unauthenticated" }) => {
      seen.push(context.auth ?? "default")
      if (context.auth !== "authenticated") return request
      const headers = new Headers(request.headers)
      headers.set("authorization", "Bearer test")
      return new Request(request, { headers })
    }

    const authenticated = await runAdversarialContract(app, {
      witnesses: {
        "GET /private": {
          auth: "authenticated",
          expected: { status: 200, body: { ok: true } },
        },
      },
      prepareRequest: prepare,
    })
    expect(authenticated.ok).toBe(true)

    const unauthenticated = await runAdversarialContract(app, {
      witnesses: {
        "GET /private": {
          auth: "unauthenticated",
          expected: { status: 401, body: { error: "unauthorized" } },
        },
      },
      prepareRequest: prepare,
    })
    expect(unauthenticated.ok).toBe(true)
    expect(unauthenticated.results[0]?.message).toContain("declared contract")
    expect(seen).toContain("authenticated")
    expect(seen).toContain("unauthenticated")
  })

  test("status witness without a declared error contract is a coverage gap", async () => {
    const app = server().get("/private", { response: t.object({ ok: t.boolean() }) }, () =>
      status(404, { error: "not_found" }),
    )
    const report = await runAdversarialContract(app, {
      witnesses: { "GET /private": { expected: { status: 404 } } },
    })
    expect(report.ok).toBe(false)
    expect(report.gaps).toContainEqual(
      expect.objectContaining({ code: "NO_STATUS_CONTRACT", route: "GET /private" }),
    )
  })

  test("synthesizes witnesses, proves nested hostile mutations, and validates responses", async () => {
    const body = t.object({
      name: t.string({ minLength: 2, maxLength: 20 }),
      profile: t.object({ age: t.integer({ minimum: 18, maximum: 120 }) }),
      tags: t.array(t.string({ minLength: 1 }), { minItems: 1, maxItems: 3 }),
    })
    const response = t.object({ id: t.string(), name: t.string() })
    const app = server().post("/users/:id", { body, response }, (c) => ({
      id: c.params.id,
      name: c.body.name,
    }))

    const report = await runAdversarialContract(app, { seed: 73, maxMutationsPerInput: 64 })

    expect(report.ok).toBe(true)
    expect(report.seed).toBe(73)
    expect(report.gaps).toEqual([])
    expect(report.results.length).toBeGreaterThan(8)
    expect(report.results.every((result) => result.ok)).toBe(true)
    expect(report.results.some((result) => result.id.includes("required-property"))).toBe(true)
    expect(report.results.some((result) => result.id.includes("additional-property"))).toBe(true)
    expect(report.results.some((result) => result.id.includes("profile.age"))).toBe(true)
    expect(report.results.some((result) => result.target === "response")).toBe(true)
    expect(report.results.every((result) => result.replay.seed === 73)).toBe(true)
  })

  test("a synthesized path satisfies a param constraint and fills a part-literal segment", async () => {
    const seen: Record<string, unknown>[] = []
    const response = t.object({ ok: t.boolean() })
    const record = (params: Record<string, unknown>) => {
      seen.push({ ...params })
      return { ok: true }
    }
    const app = server()
      .get("/users/:id{[0-9]+}", { response }, (c) => record(c.params))
      .get("/codes/:code{[A-Z]{2,3}}", { response }, (c) => record(c.params))
      .get("/img/:kind{thumb|full}", { response }, (c) => record(c.params))
      .get("/f/:name.:ext{png|jpg}", { response }, (c) => record(c.params))
      .get("/files/:name.json", { response }, (c) => record(c.params))
      .get("/o/:page{[0-9]+}?", { response }, (c) => record(c.params))
      .get("/assets/*rest", { response }, (c) => record(c.params))

    const report = await runAdversarialContract(app)

    expect(report.ok).toBe(true)
    expect(report.gaps).toEqual([])
    // Every route reached its handler: a path that missed the constraint would be a 404.
    expect(report.results.filter((result) => result.target === "response")).toHaveLength(8)
    expect(report.results.every((result) => result.ok)).toBe(true)
    expect(seen).toContainEqual({ id: "0" })
    expect(seen).toContainEqual({ code: "AA" })
    expect(seen).toContainEqual({ kind: "thumb" })
    expect(seen).toContainEqual({ name: "name-contract", ext: "png" })
    expect(seen).toContainEqual({ name: "name-contract" })
    expect(seen).toContainEqual({ page: "0" })
    expect(seen).toContainEqual({ rest: "rest/contract" })
  })

  test("a path witness is used as given, even where it does not satisfy the constraint", async () => {
    const response = t.object({ id: t.string() })
    const app = server().get("/users/:id{[0-9]+}", { response }, (c) => ({ id: c.params.id }))

    const served = await runAdversarialContract(app, {
      witnesses: { "GET /users/:id{[0-9]+}": { params: { id: "42" } } },
    })
    expect(served.ok).toBe(true)

    const missed = await runAdversarialContract(app, {
      witnesses: { "GET /users/:id{[0-9]+}": { params: { id: "ada" } } },
    })
    expect(missed.ok).toBe(false)
  })

  test("normalizes query witnesses through URL semantics before deriving mutations", async () => {
    const response = t.object({ limit: t.integer() })
    const app = server().get(
      "/search",
      { query: t.pageQuery({ maxLimit: 25 }), response },
      (c) => ({
        limit: c.query.limit ?? 10,
      }),
    )

    const report = await runAdversarialContract(app, { maxMutationsPerInput: 64 })

    expect(report.ok).toBe(true)
    expect(report.results.some((result) => result.target === "query")).toBe(true)
    expect(report.results.some((result) => result.id.includes("above-maximum"))).toBe(true)
    expect(report.results.some((result) => result.target === "response")).toBe(true)
  })

  test("requires an explicit witness for a validation-only Standard Schema", async () => {
    const opaque: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "opaque-test",
        validate: (value) =>
          typeof value === "object" &&
          value !== null &&
          "name" in value &&
          typeof value.name === "string"
            ? { value }
            : { issues: [{ message: "name is required" }] },
      },
    }
    const app = server().post("/opaque", { body: opaque }, () => ({ ok: true }))

    const missing = await runAdversarialContract(app)
    expect(missing.ok).toBe(false)
    expect(missing.gaps).toContainEqual(
      expect.objectContaining({ code: "NO_WITNESS", route: "POST /opaque", target: "body" }),
    )

    const covered = await runAdversarialContract(app, {
      witnesses: { "POST /opaque": { body: { name: "Ada" } } },
    })
    expect(covered.ok).toBe(true)
    expect(covered.gaps).toEqual([])
    expect(covered.results.length).toBeGreaterThan(0)
    expect(covered.results.some((result) => result.id.includes("missing-property"))).toBe(true)
  })

  test("catches a raw Response that violates the declared success contract", async () => {
    const app = server().get("/bad-response", { response: t.object({ id: t.string() }) }, () =>
      Response.json({ id: 123 }),
    )

    const report = await runAdversarialContract(app)
    expect(report.ok).toBe(false)
    expect(report.failures).toHaveLength(1)
    expect(report.failures[0]).toMatchObject({
      target: "response",
      status: 200,
      message: expect.stringContaining("response violates its contract"),
    })
  })

  test("executes the same stable case IDs across a runtime matrix", async () => {
    const app = server().post(
      "/matrix",
      { body: t.object({ value: t.string() }), response: t.object({ ok: t.boolean() }) },
      () => ({ ok: true }),
    )
    const calls = { bun: 0, worker: 0 }
    const report = await runAdversarialContract(app, {
      runtimes: [
        {
          name: "bun",
          fetch: (request) => {
            calls.bun += 1
            return app.fetch(request)
          },
        },
        {
          name: "worker",
          fetch: (request) => {
            calls.worker += 1
            return app.fetch(request)
          },
        },
      ],
    })

    expect(report.ok).toBe(true)
    expect(report.runtimeCount).toBe(2)
    expect(calls.bun).toBe(calls.worker)
    expect(calls.bun).toBeGreaterThan(1)
    const bunIds = report.results
      .filter((result) => result.runtime === "bun")
      .map((result) => result.id)
    const workerIds = report.results
      .filter((result) => result.runtime === "worker")
      .map((result) => result.id)
    expect(bunIds).toEqual(workerIds)
  })

  test("prepareRequest supplies auth and tenant context to every runtime request", async () => {
    const app = server().get(
      "/private/:tenant",
      { response: t.object({ tenant: t.string() }) },
      (c) =>
        c.req.headers.get("authorization") === "Bearer test"
          ? { tenant: c.params.tenant }
          : new Response("unauthorized", { status: 401 }),
    )

    const denied = await runAdversarialContract(app)
    expect(denied.ok).toBe(false)
    expect(denied.failures[0]?.status).toBe(401)

    const allowed = await runAdversarialContract(app, {
      witnesses: { "GET /private/:tenant": { params: { tenant: "acme" } } },
      prepareRequest: (request) => {
        const headers = new Headers(request.headers)
        headers.set("authorization", "Bearer test")
        return new Request(request, { headers })
      },
    })
    expect(allowed.ok).toBe(true)
  })

  test("reports accepted hostile inputs with replay data and supports custom rejection statuses", async () => {
    const body = t.object({ name: t.string({ minLength: 1 }) })
    const repaired = server({ onValidationError: () => ({ name: "repaired" }) }).post(
      "/repair",
      { body },
      () => ({ ok: true }),
    )
    const failed = await runAdversarialContract(repaired, {
      seed: 99,
      validateResponses: false,
      maxMutationsPerInput: 8,
    })
    expect(failed.ok).toBe(false)
    expect(failed.failures[0]).toMatchObject({
      status: 200,
      replay: { seed: 99, runtime: "in-process" },
    })

    const teapot = server().post(
      "/teapot",
      { body, onValidationError: () => new Response("invalid", { status: 418 }) },
      () => ({ ok: true }),
    )
    const custom = await runAdversarialContract(teapot, {
      validateResponses: false,
      expectedValidationStatuses: [418],
    })
    expect(custom.ok).toBe(true)
    expect(custom.results.every((result) => result.status === 418)).toBe(true)
  })

  test("replays a single stable case and provides a throwing assertion", async () => {
    const app = server().post("/replay", { body: t.object({ name: t.string() }) }, () => ({
      ok: true,
    }))
    const first = await runAdversarialContract(app, { validateResponses: false, seed: 101 })
    const caseId = first.results[0]?.id
    expect(caseId).toBeString()

    const replay = await runAdversarialContract(app, {
      validateResponses: false,
      seed: 101,
      only: caseId as string,
    })
    expect(replay.ok).toBe(true)
    expect(replay.results).toHaveLength(1)
    expect(replay.results[0]?.id).toBe(caseId)

    const unknown = await runAdversarialContract(app, {
      validateResponses: false,
      only: "POST /replay :: missing-case",
    })
    expect(unknown.ok).toBe(false)
    expect(unknown.gaps).toContainEqual(expect.objectContaining({ code: "CASE_NOT_FOUND" }))

    const broken = server().get("/broken", { response: t.object({ ok: t.boolean() }) }, () =>
      Response.json({ ok: "no" }),
    )
    await expect(assertAdversarialContract(broken)).rejects.toBeInstanceOf(AdversarialContractError)
  })

  test("fails closed when selected routes expose no executable contracts", async () => {
    const app = server().get("/health", () => ({ ok: true }))
    const report = await runAdversarialContract(app)
    expect(report.ok).toBe(false)
    expect(report.gaps).toEqual([expect.objectContaining({ code: "NO_CONTRACT_TARGETS" })])

    const contracted = server().post("/x", { body: t.object({ value: t.string() }) }, () => ({
      ok: true,
    }))
    const noRuntime = await runAdversarialContract(contracted, { runtimes: [] })
    expect(noRuntime.ok).toBe(false)
    expect(noRuntime.gaps).toContainEqual(expect.objectContaining({ code: "NO_RUNTIME" }))

    const duplicateRuntime = await runAdversarialContract(contracted, {
      runtimes: [
        { name: "same", fetch: (request) => contracted.fetch(request) },
        { name: "same", fetch: (request) => contracted.fetch(request) },
      ],
    })
    expect(duplicateRuntime.ok).toBe(false)
    expect(duplicateRuntime.gaps).toContainEqual(
      expect.objectContaining({ code: "INVALID_RUNTIME" }),
    )
  })

  test("formats failure details for both targeted and contract-level gaps", () => {
    const error = new AdversarialContractError({
      ok: false,
      seed: 17,
      routeCount: 1,
      targetCount: 1,
      runtimeCount: 1,
      results: [],
      failures: [
        {
          id: "case-1",
          route: "GET /private",
          runtime: "in-process",
          kind: "input-rejection",
          target: "body",
          ok: false,
          message: "unexpected acceptance",
          replay: { seed: 17, caseId: "case-1", runtime: "in-process" },
        },
      ],
      gaps: [
        { route: "GET /private", target: "body", code: "NO_WITNESS", message: "body witness" },
        { code: "NO_RUNTIME", message: "runtime missing" },
      ],
      advisories: [],
      counts: { passed: 0, failed: 1, gaps: 2 },
    })

    expect(error.name).toBe("AdversarialContractError")
    expect(error.message).toContain("in-process: case-1")
    expect(error.message).toContain("GET /private body: body witness")
    expect(error.message).toContain("contract: runtime missing")
  })

  test("shrinks an accepted hostile object through every property", async () => {
    const app = server().post(
      "/shrink",
      { body: t.object({ first: t.string(), second: t.string() }) },
      () => ({ ok: true }),
    )
    const report = await runAdversarialContract(app, {
      validateResponses: false,
      maxMutationsPerInput: 8,
      maxShrinkAttempts: 8,
      isRejected: () => false,
    })

    expect(report.ok).toBe(false)
    expect(report.failures.some((failure) => (failure.shrinkSteps ?? 0) > 0)).toBe(true)
  })
})
