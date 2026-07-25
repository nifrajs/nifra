import { describe, expect, test } from "bun:test"
import * as z from "zod"
import { t } from "../../schema/src/index.ts"
import { type AnyServer, type LogFields, type Logger, server, silentLogger } from "../src/index.ts"
import { checkResponseContract, responseContract } from "../src/server/response-contract-lane.ts"

/**
 * A `response` schema was declared everywhere and enforced nowhere: a lower bound the compiler could
 * not close either, because excess-property checking does not reach a contextually-typed handler
 * return. So the leak below type-checks, and every field crosses the wire while the client's type
 * still reports two.
 */

const LEAK = { id: "u1", name: "Ada", passwordHash: "SECRET", resetToken: "tok" }
const STRIPPING = z.object({ id: z.string(), name: z.string() })
const STRICT = t.object({ id: t.string(), name: t.string() })

/** A logger that records what it was told, so the warn path can be asserted rather than eyeballed. */
function recorder(): { logger: Logger; records: LogFields[] } {
  const records: LogFields[] = []
  const capture = (message: string, fields?: LogFields): void => {
    records.push({ ...(fields ?? {}), message })
  }
  return { logger: { debug: capture, info: capture, warn: capture, error: capture }, records }
}

/** `off` is now "the plugin was never installed", which is what keeps the lane out of the bundle. */
const applyMode = (app: AnyServer, mode: "off" | "warn" | "enforce"): AnyServer =>
  mode === "off" ? app : app.use(responseContract(mode))

const wire = async (
  mode: "off" | "warn" | "enforce",
  schema: unknown,
  logger: Logger = silentLogger,
): Promise<{ status: number; body: string }> => {
  const app = applyMode(server({ logger }), mode).get(
    "/me",
    { response: schema as never },
    () => LEAK as never,
  )
  const res = await app.fetch(new Request("http://t/me"))
  return { status: res.status, body: await res.text() }
}

describe("responseContract: off (the default)", () => {
  test("is exactly today's behaviour - the declared schema costs nothing and changes nothing", async () => {
    for (const schema of [STRIPPING, STRICT]) {
      const res = await wire("off", schema)
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body)).toEqual(LEAK) // including the fields the contract never declared
    }
  })
})

describe('responseContract: "warn"', () => {
  test("serves the response UNCHANGED, so switching it on cannot break production", async () => {
    for (const schema of [STRIPPING, STRICT]) {
      const res = await wire("warn", schema)
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body)).toEqual(LEAK)
    }
  })

  test("names the undeclared fields for a stripping schema", async () => {
    const { logger, records } = recorder()
    await wire("warn", STRIPPING, logger)
    const warned = records.find((r) => r.message === "response contract")
    expect(warned).toBeDefined()
    expect(String(warned?.detail)).toContain("passwordHash")
    expect(String(warned?.detail)).toContain("resetToken")
  })

  test("reports the issues for a strict schema", async () => {
    const { logger, records } = recorder()
    await wire("warn", STRICT, logger)
    const warned = records.find((r) => r.message === "response contract")
    expect(String(warned?.detail)).toContain("passwordHash")
  })

  test("stays quiet when the payload already matches its contract", async () => {
    const { logger, records } = recorder()
    const app = server({ logger })
      .use(responseContract("warn"))
      .get("/ok", { response: STRIPPING as never }, () => ({ id: "u1", name: "Ada" }) as never)
    await app.fetch(new Request("http://t/ok"))
    expect(records.filter((r) => r.message === "response contract")).toEqual([])
  })
})

describe('responseContract: "enforce"', () => {
  // The two validator families disagree about extra fields, and enforcement honours what each one
  // already declared rather than overriding it.
  test("a stripping schema (zod) removes the undeclared fields from the wire", async () => {
    const res = await wire("enforce", STRIPPING)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ id: "u1", name: "Ada" })
    expect(res.body).not.toContain("SECRET")
  })

  test("a strict schema (t.object) refuses to send it at all", async () => {
    const res = await wire("enforce", STRICT)
    expect(res.status).toBe(500)
    expect(res.body).not.toContain("SECRET") // the detail goes to the logger, never to the caller
  })

  test("a conforming payload is untouched", async () => {
    const app = server()
      .use(responseContract("enforce"))
      .get("/ok", { response: STRICT as never }, () => ({ id: "u1", name: "Ada" }) as never)
    const res = await app.fetch(new Request("http://t/ok"))
    expect(await res.json()).toEqual({ id: "u1", name: "Ada" })
  })

  test("a route with no response schema is unaffected", async () => {
    const app = server()
      .use(responseContract("enforce"))
      .get("/raw", () => LEAK as never)
    expect(await (await app.fetch(new Request("http://t/raw"))).json()).toEqual(LEAK)
  })

  test("a raw Response is control flow, not a payload, and is passed through", async () => {
    const app = server()
      .use(responseContract("enforce"))
      .get(
        "/redirect",
        { response: STRICT as never },
        () => new Response(null, { status: 302, headers: { location: "/" } }) as never,
      )
    const res = await app.fetch(new Request("http://t/redirect"))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/")
  })
})

describe("checkResponseContract", () => {
  test("returns synchronously for a synchronous schema", () => {
    // An app that opts in should not pay a microtask per response for a check with no work to do.
    const outcome = checkResponseContract(STRICT as never, { id: "1", name: "n" }, "enforce")
    expect(outcome).not.toBeInstanceOf(Promise)
  })

  test("awaits a schema that validates asynchronously", async () => {
    const asyncSchema = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async (value: unknown) => ({ value }),
      },
    }
    const outcome = await checkResponseContract(asyncSchema as never, LEAK, "enforce")
    expect(outcome.kind).toBe("ok")
  })

  test("undefined (a 204) has no payload to hold to the contract", () => {
    expect(checkResponseContract(STRICT as never, undefined, "enforce")).toEqual({
      kind: "ok",
      value: undefined,
    })
  })
})

/**
 * The native lane is the one that could silently defeat all of this. `Bun.serve` dispatches matched
 * routes through a compiled table that skips the lifecycle entirely, so a contracted route that stayed
 * on it would validate nothing while every test above still passed. The registration decision moves
 * those routes off it; this is what proves the move happened.
 */
describe("the Bun native lane cannot bypass the contract", () => {
  test("enforce strips undeclared fields over a real socket", async () => {
    const app = server({ logger: silentLogger })
      .use(responseContract("enforce"))
      .get("/me", { response: STRIPPING }, () => LEAK as never)
    const running = app.listen(0)
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/me`)
      const body = await res.text()
      expect(res.status).toBe(200)
      expect(JSON.parse(body)).toEqual({ id: "u1", name: "Ada" })
      expect(body).not.toContain("SECRET")
    } finally {
      await running.stop()
    }
  })

  test("off still serves the whole payload over the same path", async () => {
    const app = server({ logger: silentLogger }).get(
      "/me",
      { response: STRIPPING },
      () => LEAK as never,
    )
    const running = app.listen(0)
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/me`)
      expect(await res.json()).toEqual(LEAK)
    } finally {
      await running.stop()
    }
  })
})
