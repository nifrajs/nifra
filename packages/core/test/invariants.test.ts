import { describe, expect, test } from "bun:test"
import { classified, createSeededRandom, runContractInvariants, server } from "../src/index.ts"
import type { StandardSchemaV1 } from "../src/schema/standard.ts"

const silent = { logger: { debug() {}, info() {}, warn() {}, error() {} } }

const run = (
  app: ReturnType<typeof server>,
  options: Omit<Parameters<typeof runContractInvariants>[1], "executor"> = {},
) => runContractInvariants(app, { ...options, executor: (request) => app.fetch(request) })

/** Minimal introspectable Standard Schema: a validator plus raw JSON Schema metadata. */
function schemaOf<T>(
  jsonSchema: Record<string, unknown>,
  validate: (value: unknown) => { value: T } | { issues: { message: string }[] },
): StandardSchemaV1<T> {
  return {
    "~standard": { version: 1, vendor: "invariant-test", validate },
    jsonSchema,
  } as unknown as StandardSchemaV1<T>
}

const amountBody = schemaOf<{ amount: number }>(
  {
    type: "object",
    properties: { amount: { type: "number", minimum: 1, maximum: 100 } },
    required: ["amount"],
  },
  (value) => {
    const record = value as { amount?: unknown } | null
    return typeof record?.amount === "number"
      ? { value: { amount: record.amount } }
      : { issues: [{ message: "amount must be a number" }] }
  },
)

const okResponse = schemaOf<{ ok: boolean }>(
  { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
  (value) =>
    typeof (value as { ok?: unknown } | null)?.ok === "boolean"
      ? { value: value as { ok: boolean } }
      : { issues: [{ message: "ok must be a boolean" }] },
)

describe("createSeededRandom", () => {
  test("same seed → identical sequence; different seed → different sequence", () => {
    const a = createSeededRandom(42)
    const b = createSeededRandom(42)
    const c = createSeededRandom(43)
    const seqA = [a(), a(), a()]
    const seqB = [b(), b(), b()]
    const seqC = [c(), c(), c()]
    expect(seqA).toEqual(seqB)
    expect(seqA).not.toEqual(seqC)
    for (const value of seqA) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})

describe("runContractInvariants", () => {
  test("a conforming app passes: valid inputs fuzzed, invalid rejected, responses conform", async () => {
    const app = server(silent).post(
      "/pay/:account",
      { body: amountBody, response: okResponse },
      () => ({ ok: true }),
    )
    const report = await run(app, { seed: 7 })
    expect(report.findings).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.tested).toEqual([{ method: "POST", path: "/pay/:account" }])
  })

  test("finds a validation bypass: a schema-violating body accepted with 2xx", async () => {
    const acceptAnything = schemaOf<unknown>(
      {
        type: "object",
        properties: { amount: { type: "number" } },
        required: ["amount"],
      },
      (value) => ({ value }), // validator accepts everything the JSON Schema forbids
    )
    const app = server(silent).post("/leaky", { body: acceptAnything }, () => ({ ok: true }))
    const report = await run(app, { seed: 7 })
    expect(report.ok).toBe(false)
    expect(report.findings.some((f) => f.code === "validation-bypass")).toBe(true)
    const finding = report.findings.find((f) => f.code === "validation-bypass")
    expect(finding?.seed).toBeDefined() // reproducible from the seed
  })

  test("finds a crash on valid input (5xx)", async () => {
    const app = server(silent).post("/boom", { body: amountBody }, () => {
      throw new Error("crash")
    })
    const report = await run(app, { seed: 7, casesPerRoute: 2 })
    expect(report.findings.some((f) => f.code === "server-error-on-valid-input")).toBe(true)
  })

  test("finds a response-contract violation on a 2xx JSON response", async () => {
    const app = server(silent).post(
      "/drift",
      { body: amountBody, response: okResponse },
      () => ({ ok: "yes" }) as never, // violates the response contract at runtime
    )
    const report = await run(app, { seed: 7, casesPerRoute: 2 })
    expect(report.findings.some((f) => f.code === "response-schema-violation")).toBe(true)
  })

  test("finds an understated classification: public route with pii-tagged response fields", async () => {
    const piiResponse = classified(
      schemaOf<{ email: string }>(
        {
          type: "object",
          properties: { email: { type: "string" } },
          required: ["email"],
        },
        (value) => ({ value: value as { email: string } }),
      ),
      "pii",
    )
    const app = server(silent).get(
      "/profile",
      { response: piiResponse, classification: "public" },
      () => ({ email: "x@y.z" }),
    )
    const report = await run(app, { seed: 7, casesPerRoute: 1 })
    expect(report.findings.some((f) => f.code === "classification-understated")).toBe(true)
  })

  test("routes it cannot generate are reported as skipped — never silently dropped", async () => {
    const patternBody = schemaOf<string>(
      { type: "string", pattern: "^[A-Z]{3}-\\d{4}$" },
      (value) => ({ value: value as string }),
    )
    const opaqueBody = {
      "~standard": {
        version: 1,
        vendor: "invariant-test",
        validate: (value: unknown) => ({ value }),
      },
    } as unknown as StandardSchemaV1
    const app = server(silent)
      .post("/pattern", { body: patternBody }, () => ({ ok: true }))
      .post("/opaque", { body: opaqueBody }, () => ({ ok: true }))
    const report = await run(app, { seed: 7, casesPerRoute: 1 })
    expect(report.skipped.map((s) => s.path).sort()).toEqual(["/opaque", "/pattern"])
    for (const skip of report.skipped) expect(skip.reason.length).toBeGreaterThan(0)
  })

  test("query schemas are generated and serialized into the request", async () => {
    const query = schemaOf<{ page: number }>(
      {
        type: "object",
        properties: { page: { type: "integer", minimum: 1, maximum: 9 } },
        required: ["page"],
      },
      (value) => {
        const page = Number((value as { page?: unknown } | null)?.page)
        return Number.isInteger(page) && page >= 1
          ? { value: { page } }
          : { issues: [{ message: "page must be a positive integer" }] }
      },
    )
    let sawPage = false
    const app = server(silent).get("/list", { query }, (c) => {
      sawPage = (c.query as { page: number }).page >= 1
      return { ok: true }
    })
    const report = await run(app, { seed: 7, casesPerRoute: 3 })
    expect(report.ok).toBe(true)
    expect(sawPage).toBe(true)
  })

  test("determinism: two runs with one seed produce identical reports", async () => {
    const app = server(silent).post("/pay", { body: amountBody }, () => ({ ok: true }))
    const [a, b] = await Promise.all([run(app, { seed: 11 }), run(app, { seed: 11 })])
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  test("option validation fails closed", async () => {
    const app = server(silent).get("/x", () => ({ ok: true }))
    await expect(run(app, { seed: 1.5 })).rejects.toThrow(/seed/)
    await expect(run(app, { casesPerRoute: 0 })).rejects.toThrow(/case counts/)
    await expect(run(app, { casesPerRoute: Number.NaN })).rejects.toThrow(/case counts/)
    await expect(run(app, { invalidCasesPerRoute: 0.5 })).rejects.toThrow(/case counts/)
    await expect(runContractInvariants(app, { executor: 42 as never })).rejects.toThrow(/executor/)
  })

  test("generates const, enum, anyOf, boolean, null, arrays, and bounded integers", async () => {
    const kitchenSink = schemaOf<Record<string, unknown>>(
      {
        type: "object",
        properties: {
          count: { type: "integer", minimum: 1, maximum: 5 },
          kind: { enum: ["alpha", "beta"] },
          mode: { const: "fixed" },
          choice: { anyOf: [{ type: "boolean" }, { type: "null" }] },
          tags: {
            type: "array",
            items: { type: "string", minLength: 2, maxLength: 4 },
            minItems: 1,
          },
          empty: { type: "array" },
        },
        required: ["count", "kind", "mode", "choice", "tags", "empty"],
      },
      (value) => {
        const record = value as Record<string, unknown> | null
        return typeof record?.count === "number"
          ? { value: record as Record<string, unknown> }
          : { issues: [{ message: "count must be a number" }] }
      },
    )
    const seen: unknown[] = []
    const app = server(silent).post("/sink", { body: kitchenSink }, (c) => {
      seen.push(c.body)
      return { ok: true }
    })
    const report = await run(app, { seed: 3, casesPerRoute: 6 })
    expect(report.ok).toBe(true)
    expect(seen.length).toBeGreaterThan(0)
    for (const value of seen as Record<string, unknown>[]) {
      expect(value.mode).toBe("fixed")
      expect(["alpha", "beta"]).toContain(value.kind as string)
      expect([true, false, null]).toContain(value.choice as boolean | null)
      expect(Array.isArray(value.tags)).toBe(true)
      expect((value.count as number) >= 1 && (value.count as number) <= 5).toBe(true)
    }
  })

  test("finds a crash on invalid input (validator throws instead of returning issues)", async () => {
    const throwing = schemaOf<{ amount: number }>(
      {
        type: "object",
        properties: { amount: { type: "number" } },
        required: ["amount"],
      },
      (value) => {
        const amount = (value as { amount?: unknown } | null)?.amount
        if (typeof amount !== "number") throw new Error("validator crash on bad input")
        return { value: { amount } }
      },
    )
    const app = server(silent).post("/fragile", { body: throwing }, () => ({ ok: true }))
    const report = await run(app, { seed: 5, casesPerRoute: 1 })
    expect(report.findings.some((f) => f.code === "server-error-on-invalid-input")).toBe(true)
  })

  test("skips unsupported schema types and over-deep nesting, each with its reason", async () => {
    const unsupported = schemaOf<unknown>({ type: "tuple" }, (value) => ({ value }))
    let deep: Record<string, unknown> = { type: "string" }
    for (let level = 0; level < 12; level++) {
      deep = { type: "object", properties: { child: deep }, required: ["child"] }
    }
    const nested = schemaOf<unknown>(deep, (value) => ({ value }))
    const app = server(silent)
      .post("/unsupported", { body: unsupported }, () => ({ ok: true }))
      .post("/deep", { body: nested }, () => ({ ok: true }))
    const report = await run(app, { seed: 5, casesPerRoute: 1 })
    const reasons = new Map(report.skipped.map((s) => [s.path, s.reason]))
    expect(reasons.get("/unsupported")).toMatch(/unsupported schema type/)
    expect(reasons.get("/deep")).toMatch(/depth/)
  })

  test("serializes array-valued query params as repeated keys", async () => {
    const query = schemaOf<{ tags: string[] }>(
      {
        type: "object",
        properties: { tags: { type: "array", items: { type: "string" }, minItems: 2 } },
        required: ["tags"],
      },
      (value) => {
        const tags = (value as { tags?: unknown } | null)?.tags
        return Array.isArray(tags)
          ? { value: { tags: tags as string[] } }
          : { issues: [{ message: "tags must repeat" }] }
      },
    )
    let repeated = false
    const app = server(silent).get("/tagged", { query }, (c) => {
      repeated = (c.query as { tags: string[] }).tags.length >= 2
      return { ok: true }
    })
    const report = await run(app, { seed: 9, casesPerRoute: 4 })
    expect(report.ok).toBe(true)
    expect(repeated).toBe(true)
  })

  test("without an explicit executor, dynamic routes are reported skipped and never run", async () => {
    let executions = 0
    const app = server(silent).post("/charge", { body: amountBody }, () => {
      executions += 1
      return { ok: true }
    })
    const report = await runContractInvariants(app, { seed: 7 })
    expect(executions).toBe(0)
    expect(report.tested).toEqual([])
    expect(report.skipped).toEqual([
      { method: "POST", path: "/charge", reason: "no isolated executor configured" },
    ])
  })

  test("a declared JSON response returned as text is a conformance failure", async () => {
    const app = server(silent).get(
      "/wrong-content",
      { response: okResponse },
      () => new Response("not json", { headers: { "content-type": "text/plain" } }) as never,
    )
    const report = await run(app, { seed: 2, casesPerRoute: 1 })
    expect(report.findings.some((finding) => finding.code === "response-schema-violation")).toBe(
      true,
    )
  })

  test("sandbox executor throws become findings instead of aborting the whole audit", async () => {
    const app = server(silent).post("/throws", { body: amountBody }, () => ({ ok: true }))
    const report = await runContractInvariants(app, {
      casesPerRoute: 1,
      invalidCasesPerRoute: 1,
      executor: () => {
        throw new Error("sandbox crashed")
      },
    })
    expect(report.findings.map((finding) => finding.code)).toContain("server-error-on-valid-input")
    expect(report.findings.map((finding) => finding.code)).toContain(
      "server-error-on-invalid-input",
    )
  })

  test("impossible bounds are skipped and array maxItems is honored", async () => {
    const impossible = schemaOf<string>(
      { type: "string", minLength: 3, maxLength: 2 },
      (value) => ({ value: value as string }),
    )
    const bounded = schemaOf<{ tags: string[] }>(
      {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 1 },
        },
        required: ["tags"],
      },
      (value) => ({ value: value as { tags: string[] } }),
    )
    const lengths: number[] = []
    const app = server(silent)
      .post("/impossible", { body: impossible }, () => ({ ok: true }))
      .post("/bounded", { body: bounded }, (c) => {
        lengths.push((c.body as { tags: string[] }).tags.length)
        return { ok: true }
      })
    const report = await run(app, { casesPerRoute: 4, invalidCasesPerRoute: 0 })
    expect(report.skipped.find((route) => route.path === "/impossible")?.reason).toMatch(/bounds/)
    expect(lengths).toEqual([1, 1, 1, 1])
  })
})
