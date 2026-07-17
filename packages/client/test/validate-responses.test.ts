import { describe, expect, test } from "bun:test"
import { ResponseContractViolation, testClient } from "@nifrajs/client"
import type { StandardResult, StandardSchemaV1, StandardTypes } from "@nifrajs/core"
import { server } from "@nifrajs/core"
import { withResponseValidation } from "../src/validate-responses.ts"

function schema<O>(
  validate: (value: unknown) => StandardResult<O> | Promise<StandardResult<O>>,
): StandardSchemaV1<unknown, O> {
  return {
    "~standard": {
      version: 1,
      vendor: "nifra-test",
      validate,
      types: undefined as unknown as StandardTypes<unknown, O>,
    },
  }
}

const greetingResponse = schema<{ greeting: string }>((v) =>
  typeof v === "object" && v !== null && "greeting" in v && typeof v.greeting === "string"
    ? { value: { greeting: v.greeting } }
    : { issues: [{ message: "greeting must be a string", path: ["greeting"] }] },
)

const notFoundBody = schema<{ code: "missing" }>((v) =>
  typeof v === "object" && v !== null && "code" in v && (v as { code: unknown }).code === "missing"
    ? { value: { code: "missing" as const } }
    : { issues: [{ message: "code must be 'missing'", path: ["code"] }] },
)

// The drifted app: /honest keeps its contract, /drifted returns a shape its schema forbids,
// /errors declares its 404 body, /undeclared returns a status with no schema at all.
const app = server()
  .get("/honest", { response: greetingResponse }, () => ({ greeting: "hi" }))
  .get(
    "/drifted",
    { response: greetingResponse },
    () => ({ greeting: 42 }) as unknown as { greeting: string },
  )
  .get("/errors/:kind", { response: greetingResponse, errors: { 404: notFoundBody } }, (c) => {
    if (c.params.kind === "good") return { greeting: "found" }
    if (c.params.kind === "declared") return c.json({ code: "missing" }, 404)
    if (c.params.kind === "drifted") return c.json({ code: "wrong" }, 404)
    return c.json({ anything: true }, 418) // no schema declared for 418
  })
  .get("/plain", () => ({ anything: "goes" }))

describe("testClient validateResponses", () => {
  const api = testClient<typeof app>(app, { validateResponses: true })

  test("a response matching its contract passes through untouched", async () => {
    const res = await api.honest.get()
    expect(res.ok).toBe(true)
    expect(res.data).toEqual({ greeting: "hi" })
  })

  test("a 2xx body that drifts from schema.response throws loudly", async () => {
    await expect(api.drifted.get()).rejects.toThrow(/response contract violation.*greeting/)
  })

  test("a declared error status validates against errors[status]", async () => {
    const res = await api.errors({ kind: "declared" }).get()
    expect(res.ok).toBe(false)
    expect(res.status).toBe(404)
  })

  test("a drifted declared-error body throws", async () => {
    await expect(api.errors({ kind: "drifted" }).get()).rejects.toThrow(
      /response contract violation.*404.*code/,
    )
  })

  test("statuses with no declared schema pass through unchecked", async () => {
    const res = await api.errors({ kind: "teapot" }).get()
    expect(res.status).toBe(418)
  })

  test("routes with no schemas are never validated", async () => {
    const res = await api.plain.get()
    expect(res.ok).toBe(true)
  })

  test("off by default: the same drifted app passes without the flag", async () => {
    const relaxed = testClient<typeof app>(app)
    const res = await relaxed.drifted.get()
    expect(res.ok).toBe(true)
  })

  test("an app without .routes() is rejected at client creation", () => {
    const bare = { fetch: (_req: Request) => new Response("{}") }
    expect(() => testClient(bare as never, { validateResponses: true })).toThrow(/routes\(\)/)
  })

  test("passthrough responses stay readable and violations preserve their error type", async () => {
    const validating = schema(() => ({
      issues: [
        { message: "root is invalid" },
        { message: "value is invalid", path: [{ key: "nested" }, "value"] },
      ],
    }))
    const introspectable = {
      routes: () => [{ method: "GET", path: "/checked", schema: { response: validating } }],
    }
    const responses = new Map<string, Response>([
      ["/checked", new Response("not json", { headers: { "content-type": "text/plain" } })],
      [
        "/checked?malformed=1",
        new Response("{", { headers: { "content-type": "application/json" } }),
      ],
      ["/checked?empty=1", new Response(null, { status: 204 })],
      ["/checked?reset=1", new Response(null, { status: 205 })],
      [
        "/missing",
        new Response('{"unchecked":true}', { headers: { "content-type": "application/json" } }),
      ],
    ])
    const validatedFetch = withResponseValidation(introspectable, async (url) => {
      const parsed = new URL(url)
      return responses.get(parsed.pathname + parsed.search) ?? responses.get(parsed.pathname)!
    })

    const plain = await validatedFetch("https://example.test/checked")
    expect(await plain.text()).toBe("not json")
    const malformed = await validatedFetch("https://example.test/checked?malformed=1")
    expect(await malformed.text()).toBe("{")
    expect((await validatedFetch("https://example.test/checked?empty=1")).status).toBe(204)
    expect((await validatedFetch("https://example.test/checked?reset=1")).status).toBe(205)
    expect(await (await validatedFetch("https://example.test/missing")).json()).toEqual({
      unchecked: true,
    })

    await expect(
      validatedFetch("https://example.test/checked", { method: "HEAD" }),
    ).resolves.toBeInstanceOf(Response)
    const violation = withResponseValidation(
      introspectable,
      async () =>
        new Response("{}", { headers: { "content-type": "application/json; charset=utf-8" } }),
    )("https://example.test/checked")
    let caught: unknown
    try {
      await violation
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ResponseContractViolation)
    expect(caught).toHaveProperty("name", "ResponseContractViolation")
    expect(caught).toHaveProperty(
      "message",
      expect.stringMatching(/root is invalid; nested\.value: value is invalid/),
    )
  })
})
