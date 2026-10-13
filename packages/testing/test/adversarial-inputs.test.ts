import { beforeAll, describe, expect, test } from "bun:test"
import { server, status } from "@nifrajs/core"
import { explainAutoReflectJsonSchema } from "@nifrajs/mock"
import { t } from "@nifrajs/schema"
import { runAdversarialContract } from "../src/index.ts"

/**
 * Declared params and headers get witnesses of their own, so a body or query case is rejected by the
 * input it mutates, not by a placeholder param or a missing header. Credentials are never invented.
 */

const issuePaths = async (response: Response): Promise<string[]> => {
  const body: unknown = await response.clone().json()
  const issues = Reflect.get(Object(body), "issues")
  return Array.isArray(issues)
    ? issues.map((issue) => String(Reflect.get(Object(issue), "path")))
    : []
}

describe("params and headers witnesses", () => {
  test("a declared params schema is synthesized, so body cases reach the body validator", async () => {
    const app = server().post(
      "/users/:id",
      {
        params: t.object({ id: t.string({ format: "uuid" }) }),
        body: t.object({ name: t.string({ minLength: 1 }) }),
      },
      () => ({ ok: true }),
    )
    const bodyIssues: string[] = []
    const report = await runAdversarialContract(app, {
      isRejected: async (response, context) => {
        if (context.target === "body") bodyIssues.push(...(await issuePaths(response)))
        return response.status === 422
      },
    })
    expect(report.gaps).toEqual([])
    expect(report.ok).toBe(true)
    const targets = new Set(report.results.map((result) => result.target))
    expect(targets).toEqual(new Set(["params", "body"]))
    expect(bodyIssues.length).toBeGreaterThan(0)
    expect(bodyIssues.some((path) => path === "id")).toBe(false)
  })

  test("an opaque params schema with no witness is a gap, not a placeholder", async () => {
    const opaque = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (value: unknown) => ({ value }),
      },
    }
    const app = server().get("/items/:id", { params: opaque }, () => ({ ok: true }))
    const report = await runAdversarialContract(app)
    expect(report.gaps.map((gap) => [gap.target, gap.code])).toEqual([["params", "NO_WITNESS"]])
    const witnessed = await runAdversarialContract(app, {
      witnesses: { "GET /items/:id": { params: { id: "7" } } },
    })
    expect(witnessed.gaps.map((gap) => gap.code)).not.toContain("NO_WITNESS")
  })

  test("headers: declared fields are synthesized and mutated; credentials never are", async () => {
    const headers = t.object({
      "x-tenant": t.string({ minLength: 3 }),
      authorization: t.string({ minLength: 1 }),
    })
    const app = server().get("/me", { headers }, (c) => ({ tenant: c.headers["x-tenant"] }))
    const missing = await runAdversarialContract(app)
    expect(missing.gaps.map((gap) => [gap.target, gap.code])).toEqual([["headers", "NO_WITNESS"]])
    expect(missing.gaps[0]?.message).toContain("never invents credentials: set authorization")

    const seen: string[] = []
    const report = await runAdversarialContract(app, {
      witnesses: { "GET /me": { headers: { authorization: "Bearer test" } } },
      prepareRequest: (request) => {
        seen.push(request.headers.get("authorization") ?? "(none)")
        return request
      },
    })
    expect(report.gaps).toEqual([])
    expect(report.ok).toBe(true)
    const mutated = report.results.filter((result) => result.target === "headers")
    expect(mutated.length).toBeGreaterThan(0)
    expect(mutated.every((result) => result.mutation?.startsWith("headers.x-tenant"))).toBe(true)
    expect(new Set(seen)).toEqual(new Set(["Bearer test"]))
  })

  test("a header field typed as bare text has nothing to reject, and that is not a gap", async () => {
    const app = server().get("/plain", { headers: t.object({ "x-trace": t.string() }) }, () => ({
      ok: true,
    }))
    const report = await runAdversarialContract(app, { validateResponses: false })
    expect(report.gaps).toEqual([])
  })

  test("cookies are never synthesized: a declared cookie schema needs the witness to carry one", async () => {
    const cookies = t.object({ session: t.string() })
    const app = server().post("/notes", { cookies, body: t.object({ text: t.string() }) }, () => ({
      ok: true,
    }))
    const missing = await runAdversarialContract(app)
    expect(missing.gaps.map((gap) => [gap.target, gap.code])).toEqual([["cookies", "NO_WITNESS"]])
    expect(missing.results).toEqual([])
    const witnessed = await runAdversarialContract(app, {
      witnesses: { "POST /notes": { headers: { cookie: "session=test" } } },
    })
    expect(witnessed.gaps).toEqual([])
    expect(witnessed.ok).toBe(true)
  })
})

describe("the zod bridge says why a schema stayed opaque", () => {
  const fake = {
    "~standard": {
      version: 1 as const,
      vendor: "zod",
      validate: (value: unknown) => ({ value }),
    },
  }
  // The first probe cold-loads zod's CJS build, which has passed the 5s test default on a loaded
  // Windows runner; the probe is cached per cwd, so the test itself never pays it.
  beforeAll(() => {
    explainAutoReflectJsonSchema(fake)
  }, 30_000)

  test("a zod-tagged schema the converter cannot read names the reason in the gap", async () => {
    expect(explainAutoReflectJsonSchema(fake)).toStartWith("zod's toJSONSchema threw")
    expect(explainAutoReflectJsonSchema({ "~standard": { vendor: "valibot" } })).toBeUndefined()
    const app = server().post("/z", { body: fake }, () => ({ ok: true }))
    const report = await runAdversarialContract(app)
    expect(report.gaps[0]?.message).toContain("(zod's toJSONSchema threw")
  })
})

describe("requests carry what real clients send", () => {
  test("a closed header schema passes on a route with a body", async () => {
    const app = server().post(
      "/notes",
      {
        headers: t.object({ "x-tenant": t.string({ minLength: 1 }) }),
        body: t.object({ text: t.string({ minLength: 1 }) }),
        response: t.object({ saved: t.boolean() }),
      },
      () => ({ saved: true }),
    )
    const report = await runAdversarialContract(app)
    expect(report.gaps).toEqual([])
    expect(report.results.filter((result) => !result.ok)).toEqual([])
  })

  test("a header schema that refuses undeclared names is a gap naming what it refused", async () => {
    const strict = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (value: unknown) => {
          const extra = Object.keys(Object(value)).filter((name) => name !== "x-tenant")
          return extra.length === 0
            ? { value }
            : { issues: extra.map((name) => ({ message: "Unexpected property", path: [name] })) }
        },
      },
    }
    const app = server().get(
      "/notes",
      { headers: strict, response: t.object({ count: t.integer() }) },
      () => ({ count: 1 }),
    )
    const report = await runAdversarialContract(app, {
      witnesses: { "GET /notes": { headers: { "x-tenant": "1" } } },
    })
    expect(report.gaps.map((gap) => [gap.target, gap.code])).toEqual([
      ["headers", "INVALID_WITNESS"],
    ])
    expect(report.gaps[0]?.message).toContain("user-agent - Unexpected property")
    expect(report.gaps[0]?.message).toContain("a header schema must accept them")
  })

  test("a valid witness answered with a validation 422 names the refused fields", async () => {
    const app = server()
      .beforeHandle(() =>
        status(422, {
          ok: false,
          error: "validation",
          issues: [{ message: "Unexpected property", path: ["x-trace"] }],
        }),
      )
      .get("/count", { response: t.object({ count: t.integer() }) }, () => ({ count: 1 }))
    const report = await runAdversarialContract(app)
    const failed = report.results.find((result) => result.kind === "response-conformance")
    expect(failed?.message).toBe(
      "valid witness returned non-success status 422: x-trace - Unexpected property",
    )
  })
})
