import { describe, expect, test } from "bun:test"
import * as z from "zod"
import { t } from "../../schema/src/index.ts"
import {
  type AnyServer,
  type LogFields,
  type Logger,
  type StandardSchemaV1,
  server,
  silentLogger,
  status,
} from "../src/index.ts"
import {
  checkResponseContract,
  type ResponseContractReport,
  responseContract,
} from "../src/server/response-contract-lane.ts"

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

  test("a status() result keeps its status and headers", async () => {
    const app = server()
      .use(responseContract("warn"))
      .post("/users", { response: STRIPPING }, () =>
        status(201, LEAK, { headers: { "x-request": "r1" } }),
      )
      .get("/missing", { errors: { 404: STRIPPING } }, () => status(404, LEAK))
    const created = await app.fetch(new Request("http://t/users", { method: "POST" }))
    expect(created.status).toBe(201)
    expect(created.headers.get("x-request")).toBe("r1")
    expect(await created.json()).toEqual(LEAK)
    const missing = await app.fetch(new Request("http://t/missing"))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual(LEAK)
  })

  test("a c.json reply is reported and served unchanged", async () => {
    const { logger, records } = recorder()
    const app = server({ logger })
      .use(responseContract("warn"))
      .get("/me", { response: STRIPPING }, (c) => c.json(LEAK, 203))
    const res = await app.fetch(new Request("http://t/me"))
    expect(res.status).toBe(203)
    expect(await res.json()).toEqual(LEAK)
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

  // `JSON.stringify` writes what a `toJSON` hook returns, not the fields the validator was shown.
  describe("a value with a toJSON hook", () => {
    class Account {
      id = "u1"
      name = "Ada"
      #passwordHash = "SECRET"
      toJSON() {
        return { id: this.id, name: this.name, passwordHash: this.#passwordHash }
      }
    }
    class Price {
      constructor(readonly cents: number) {}
      toJSON() {
        return (this.cents / 100).toFixed(2)
      }
    }
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: what these values write by toJSON is the declared row, which no static type can say.
    const writesRow = (value: object): { id: string; name: string } => value as never
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the wrapper's toJSON writes the declared list, which no static type can say.
    const writesTags = (value: object): string[] => value as never

    test("is judged by what the hook writes, at the top, nested, and in a c.json reply", async () => {
      const app = server({ logger: silentLogger })
        .use(responseContract("enforce"))
        .get("/me", { response: STRICT }, () => new Account())
        .get("/list", { response: t.object({ users: t.array(STRICT) }) }, () => ({
          users: [{ id: "u0", name: "Bo" }, new Account()],
        }))
        .get("/reply", { response: STRICT }, (c) => c.json(new Account()))
      for (const path of ["/me", "/list", "/reply"]) {
        const res = await app.fetch(new Request(`http://t${path}`))
        expect(res.status).toBe(500)
        expect(await res.text()).not.toContain("SECRET")
      }
    })

    test("strip sends the declared fields of the value, never what its hook adds", async () => {
      const app = server({ logger: silentLogger })
        .use(responseContract("enforce", { extra: "strip" }))
        .get("/me", { response: STRICT }, () => new Account())
      expect(await (await app.fetch(new Request("http://t/me"))).json()).toEqual({
        id: "u1",
        name: "Ada",
      })
    })

    test("strip keeps a declared field the hook writes from private state, at the top and nested", async () => {
      class Member {
        #id = "u1"
        name = "Ada"
        toJSON() {
          return { id: this.#id, name: this.name, passwordHash: "SECRET" }
        }
      }
      const app = server({ logger: silentLogger })
        .use(responseContract("enforce", { extra: "strip" }))
        .get("/me", { response: STRICT }, () => writesRow(new Member()))
        .get("/list", { response: t.object({ users: t.array(STRICT) }) }, () => ({
          users: [writesRow(new Member())],
        }))
      const me = await app.fetch(new Request("http://t/me"))
      expect(me.status).toBe(200)
      expect(await me.json()).toEqual({ id: "u1", name: "Ada" })
      const list = await app.fetch(new Request("http://t/list"))
      expect(list.status).toBe(200)
      expect(await list.json()).toEqual({ users: [{ id: "u1", name: "Ada" }] })
    })

    test("strip reports the fields a hook writes that were not sent", async () => {
      const reports: ResponseContractReport[] = []
      const app = server({ logger: silentLogger })
        .use(
          responseContract("enforce", {
            extra: "strip",
            onReport: (report) => void reports.push(report),
          }),
        )
        .get("/me", { response: STRICT }, () => new Account())
      expect(await (await app.fetch(new Request("http://t/me"))).json()).toEqual({
        id: "u1",
        name: "Ada",
      })
      expect(reports).toMatchObject([{ kind: "stripped", fields: ["passwordHash"] }])
    })

    test("a hook's result is written by its fields, never by a hook of its own", async () => {
      class Wrapper {
        constructor(readonly inner: object) {}
        toJSON() {
          return this.inner
        }
      }
      // The serializer calls one hook per value: this writes the account's own fields, not its hook's.
      expect(JSON.parse(JSON.stringify(new Wrapper(new Account())))).toEqual({
        id: "u1",
        name: "Ada",
      })
      for (const extra of ["reject", "strip"] as const) {
        const app = server({ logger: silentLogger })
          .use(responseContract("enforce", { extra }))
          .get("/me", { response: STRICT }, () => writesRow(new Wrapper(new Account())))
        const res = await app.fetch(new Request("http://t/me"))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ id: "u1", name: "Ada" })
      }
      const tags = Object.assign(["a", "b"], { toJSON: () => "SECRET" })
      const tagged = server({ logger: silentLogger })
        .use(responseContract("enforce"))
        .get("/tags", { response: t.object({ tags: t.array(t.string()) }) }, () => ({
          tags: writesTags(new Wrapper(tags)),
        }))
      expect(await (await tagged.fetch(new Request("http://t/tags"))).json()).toEqual({
        tags: ["a", "b"],
      })
    })

    test("a hook that writes the declared shape passes, and its output is what is sent", async () => {
      const app = server({ logger: silentLogger })
        .use(responseContract("enforce"))
        .get(
          "/item",
          { response: t.object({ id: t.string(), price: t.string(), at: t.date() }) },
          // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: `Price` is written as the declared string by its toJSON, which no static type can say.
          () => ({ id: "i1", price: new Price(1250), at: new Date(0) }) as never,
        )
      const res = await app.fetch(new Request("http://t/item"))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        id: "i1",
        price: "12.50",
        at: "1970-01-01T00:00:00.000Z",
      })
    })

    test("warn names what the hook adds and still sends it unchanged", async () => {
      const { logger, records } = recorder()
      const app = server({ logger })
        .use(responseContract("warn"))
        .get("/me", { response: STRICT }, () => new Account())
      expect(await (await app.fetch(new Request("http://t/me"))).json()).toEqual({
        id: "u1",
        name: "Ada",
        passwordHash: "SECRET",
      })
      const warned = records.find((r) => r.message === "response contract")
      expect(String(warned?.detail)).toContain("passwordHash")
    })

    test("warn sends what it judged, even from a hook that writes something new each call", async () => {
      let calls = 0
      class Ticket {
        toJSON() {
          return { id: "u1", name: "Ada", [`extra${++calls}`]: true }
        }
      }
      const { logger, records } = recorder()
      const app = server({ logger })
        .use(responseContract("warn"))
        .get("/plain", { response: STRICT }, () => writesRow(new Ticket()))
        .get("/status", { response: STRICT }, () => status(200, writesRow(new Ticket())))
        .get("/reply", { response: STRICT }, (c) => c.json(writesRow(new Ticket())))
      for (const path of ["/plain", "/status", "/reply"]) {
        const body: object = await (await app.fetch(new Request(`http://t${path}`))).json()
        const sent = Object.keys(body).find((key) => key.startsWith("extra"))
        const warned = records.findLast((r) => r.message === "response contract")
        expect(sent).toBeDefined()
        expect(String(warned?.detail)).toContain(`${sent}:`)
      }
    })
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
      // A 2xx raw Response has a declared schema for its status, and is still not read.
      .get("/raw", { response: STRICT }, () => new Response("raw bytes", { status: 200 }))
    const res = await app.fetch(new Request("http://t/redirect"))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/")
    const raw = await app.fetch(new Request("http://t/raw"))
    expect(raw.status).toBe(200)
    expect(await raw.text()).toBe("raw bytes")
  })

  test("a c.json reply is held to the contract like a returned value", async () => {
    const app = server()
      .use(responseContract("enforce"))
      .get("/me", { response: STRIPPING }, (c) =>
        c.json(LEAK, { status: 201, headers: { "x-request": "r1" } }),
      )
      .get("/strict", { response: STRICT }, (c) => c.json(LEAK))
      .get("/missing", { errors: { 404: STRIPPING } }, (c) => c.json(LEAK, 404))
    const res = await app.fetch(new Request("http://t/me"))
    expect(res.status).toBe(201)
    expect(res.headers.get("x-request")).toBe("r1")
    expect(res.headers.get("content-type")).toContain("application/json")
    const body = await res.text()
    expect(JSON.parse(body)).toEqual({ id: "u1", name: "Ada" })
    expect(body).not.toContain("SECRET")
    const strict = await app.fetch(new Request("http://t/strict"))
    expect(strict.status).toBe(500)
    expect(await strict.text()).not.toContain("SECRET")
    const missing = await app.fetch(new Request("http://t/missing"))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ id: "u1", name: "Ada" })
  })

  test("enforces a declared error contract on status() responses", async () => {
    const app = server()
      .use(responseContract("enforce"))
      .get("/missing", { errors: { 404: STRIPPING as never } }, () => status(404, LEAK) as never)
    const res = await app.fetch(new Request("http://t/missing"))
    expect(res.status).toBe(404)
    const body = await res.text()
    expect(JSON.parse(body)).toEqual({ id: "u1", name: "Ada" })
    expect(body).not.toContain("SECRET")
  })

  test("uses the success contract for status(200) responses", async () => {
    const app = server()
      .use(responseContract("enforce"))
      .get("/ok", { response: STRIPPING as never }, () => status(200, LEAK) as never)
    const res = await app.fetch(new Request("http://t/ok"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: "u1", name: "Ada" })
  })

  test("enforces error contracts when a status result is thrown", async () => {
    const app = server()
      .use(responseContract("enforce"))
      .get("/missing", { errors: { 404: STRIPPING as never } }, () => {
        throw status(404, LEAK)
      })
    const res = await app.fetch(new Request("http://t/missing"))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ id: "u1", name: "Ada" })
  })

  test("a checked status() result keeps its status and headers", async () => {
    const app = server()
      .use(responseContract("enforce"))
      .post("/users", { response: STRIPPING }, () =>
        status(201, LEAK, { headers: { "x-request": "r1" } }),
      )
      .get("/missing", { errors: { 404: STRIPPING } }, () =>
        status(404, LEAK, { headers: { "x-request": "r2" } }),
      )
    const created = await app.fetch(new Request("http://t/users", { method: "POST" }))
    expect(created.status).toBe(201)
    expect(created.headers.get("x-request")).toBe("r1")
    expect(await created.json()).toEqual({ id: "u1", name: "Ada" })
    const missing = await app.fetch(new Request("http://t/missing"))
    expect(missing.status).toBe(404)
    expect(missing.headers.get("x-request")).toBe("r2")
    expect(await missing.json()).toEqual({ id: "u1", name: "Ada" })
  })

  test("a reply whose status has no declared schema is sent as it is", async () => {
    const app = server()
      .use(responseContract("enforce"))
      .get("/conflict", { errors: { 404: STRIPPING } }, () => status(409, LEAK))
      .get("/teapot", { errors: { 404: STRIPPING } }, (c) => c.json(LEAK, 418))
      .get("/ok", { errors: { 404: STRIPPING } }, () => LEAK)
    for (const [path, code] of [
      ["/conflict", 409],
      ["/teapot", 418],
      ["/ok", 200],
    ] as const) {
      const res = await app.fetch(new Request(`http://t${path}`))
      expect(res.status).toBe(code)
      expect(await res.json()).toEqual(LEAK)
    }
  })
})

// A database driver hands back a `Date` for a timestamp column, and JSON writes it as its ISO string,
// which is what a backend route declares: `t.string({ format: "date-time" })`.
describe("a Date in the payload", () => {
  const AT = new Date("2026-10-25T12:00:00.000Z")
  const ISO = AT.toISOString()
  const STAMP = t.string({ format: "date-time" })
  const ROW = t.object({ id: t.string(), createdAt: STAMP })
  const PAGE = t.object({ items: t.array(ROW), meta: t.object({ at: STAMP }) })
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: a `Date` is written as the declared ISO string, which no static type can say.
  const stamp = (date: Date): string => date as never
  const row = () => ({ id: "a", createdAt: stamp(AT) })
  const SENT_ROW = { id: "a", createdAt: ISO }

  const routes = (contract: ReturnType<typeof responseContract>, logger: Logger = silentLogger) =>
    server({ logger })
      .use(contract)
      .get("/top", { response: STAMP }, () => stamp(AT))
      .get("/row", { response: ROW }, row)
      .get("/page", { response: PAGE }, () => ({ items: [row(), row()], meta: { at: stamp(AT) } }))
      .get("/reply", { response: ROW }, (c) => c.json(row()))
      .get("/status", { response: ROW }, () => status(201, row()))
  const SENT: ReadonlyArray<readonly [string, number, unknown]> = [
    ["/top", 200, ISO],
    ["/row", 200, SENT_ROW],
    ["/page", 200, { items: [SENT_ROW, SENT_ROW], meta: { at: ISO } }],
    ["/reply", 200, SENT_ROW],
    ["/status", 201, SENT_ROW],
  ]

  test("enforce judges a string field by the ISO string it is written as, at the top, nested and in a list", async () => {
    for (const extra of ["reject", "strip"] as const) {
      const app = routes(responseContract("enforce", { extra }))
      for (const [path, code, body] of SENT) {
        const res = await app.fetch(new Request(`http://t${path}`))
        expect(res.status).toBe(code)
        expect(await res.json()).toEqual(body)
      }
    }
  })

  test("warn reports nothing and sends the payload as it came", async () => {
    const { logger, records } = recorder()
    const reports: ResponseContractReport[] = []
    const app = routes(
      responseContract("warn", { onReport: (report) => void reports.push(report) }),
      logger,
    )
    for (const [path, code, body] of SENT) {
      const res = await app.fetch(new Request(`http://t${path}`))
      expect(res.status).toBe(code)
      expect(await res.json()).toEqual(body)
    }
    expect(records.filter((r) => r.message === "response contract")).toEqual([])
    expect(reports).toEqual([])
  })

  test("each mode calls every toJSON hook once, a Date's included, in a c.json reply too", async () => {
    let dates = 0
    let hooks = 0
    const sentRow = () => {
      const date = new Date(AT)
      // `Date.prototype.toJSON` writes through `toISOString`.
      date.toISOString = () => {
        dates++
        return ISO
      }
      const id = {
        toJSON: () => {
          hooks++
          return "a"
        },
      }
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the hook writes the declared string, which no static type can say.
      return { id: id as never, createdAt: stamp(date) }
    }
    for (const mode of ["warn", "enforce"] as const) {
      const app = server({ logger: silentLogger })
        .use(responseContract(mode))
        .get("/row", { response: ROW }, sentRow)
        .get("/status", { response: ROW }, () => status(201, sentRow()))
        .get("/reply", { response: ROW }, (c) => c.json(sentRow()))
        .get("/missing", { errors: { 404: ROW } }, (c) => c.json(sentRow(), 404))
      for (const path of ["/row", "/status", "/reply", "/missing"]) {
        dates = 0
        hooks = 0
        const res = await app.fetch(new Request(`http://t${path}`))
        expect(await res.json()).toEqual(SENT_ROW)
        expect({ mode, path, dates, hooks }).toEqual({ mode, path, dates: 1, hooks: 1 })
      }
    }
  })

  test("a Date is written as its toJSON writes it, whichever method it overrides and where", async () => {
    let at = AT
    const app = server({ logger: silentLogger })
      .use(responseContract("enforce"))
      .get("/at", { response: t.object({ at: t.union([t.string(), t.null()]) }) }, () => ({
        at: stamp(at),
      }))
    const sent = async (date: Date) => {
      at = date
      const expected = JSON.stringify({ at: date })
      return { text: await (await app.fetch(new Request("http://t/at"))).text(), expected }
    }
    for (const date of [AT, new Date(Number.NaN), new Date(8.64e15), new Date(-8.64e15)]) {
      const { text, expected } = await sent(date)
      expect(text).toBe(expected)
    }
    // Each method `Date.prototype.toJSON` calls, overridden on the instance, a subclass and
    // `Date.prototype` itself, with answers that change what it writes: a time value that is not
    // finite, and a `valueOf` whose string or object answer `toJSON` reads past to `toISOString`.
    const overrides: ReadonlyArray<readonly [PropertyKey, () => unknown]> = [
      [Symbol.toPrimitive, () => Number.NaN],
      ["valueOf", () => Number.NaN],
      ["valueOf", () => "text"],
      ["valueOf", () => ({})],
      ["toISOString", () => "custom"],
    ]
    for (const [method, answer] of overrides) {
      for (const where of ["own", "class", "global"] as const) {
        const override = { value: answer, configurable: true, writable: true }
        const shipped = Object.getOwnPropertyDescriptor(Date.prototype, method)
        let date = new Date(AT)
        if (where === "own") Object.defineProperty(date, method, override)
        if (where === "class") {
          class Stamp extends Date {}
          Object.defineProperty(Stamp.prototype, method, override)
          date = new Stamp(AT.getTime())
        }
        if (where === "global") Object.defineProperty(Date.prototype, method, override)
        try {
          const { text, expected } = await sent(date)
          expect({ method: String(method), answer: String(answer()), where, text }).toEqual({
            method: String(method),
            answer: String(answer()),
            where,
            text: expected,
          })
        } finally {
          if (where === "global" && shipped !== undefined)
            Object.defineProperty(Date.prototype, method, shipped)
        }
      }
    }
  })

  test("strip drops an undeclared field beside a Date, and names it", async () => {
    const reports: ResponseContractReport[] = []
    const app = server({ logger: silentLogger })
      .use(
        responseContract("enforce", {
          extra: "strip",
          onReport: (report) => void reports.push(report),
        }),
      )
      .get("/page", { response: PAGE }, () => ({
        items: [{ ...row(), passwordHash: "SECRET" }],
        meta: { at: stamp(AT), deletedAt: AT },
      }))
    const res = await app.fetch(new Request("http://t/page"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ items: [SENT_ROW], meta: { at: ISO } })
    expect(reports).toMatchObject([
      { kind: "stripped", fields: ["items[].passwordHash", "meta.deletedAt"] },
    ])
  })

  test("a t.date() field keeps the Date beside a string field that is written", async () => {
    const MIXED = t.object({
      at: t.date(),
      createdAt: STAMP,
      maybe: t.union([t.date(), t.null()]),
      items: t.array(t.object({ when: t.date(), createdAt: STAMP })),
      byName: t.record(t.object({ when: t.date(), createdAt: STAMP })),
    })
    for (const extra of ["reject", "strip"] as const) {
      const app = server({ logger: silentLogger })
        .use(responseContract("enforce", { extra }))
        .get("/mixed", { response: MIXED }, () => ({
          at: AT,
          createdAt: stamp(AT),
          maybe: AT,
          items: [{ when: AT, createdAt: stamp(AT) }],
          byName: { ada: { when: AT, createdAt: stamp(AT) } },
        }))
      const res = await app.fetch(new Request("http://t/mixed"))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        at: ISO,
        createdAt: ISO,
        maybe: ISO,
        items: [{ when: ISO, createdAt: ISO }],
        byName: { ada: { when: ISO, createdAt: ISO } },
      })
    }
  })

  test("a Date is still refused where what it writes does not fit", async () => {
    const { logger, records } = recorder()
    const app = server({ logger })
      .use(responseContract("enforce", { extra: "strip" }))
      .get("/number", { response: t.object({ at: t.number() }) }, () => ({ at: AT.getTime() }))
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the wrong type is the point of this route.
      .get("/wrong", { response: t.object({ at: t.number() }) }, () => ({ at: AT as never }))
      // An invalid `Date` is written as `null`.
      .get("/invalid", { response: ROW }, () => ({
        id: "a",
        createdAt: stamp(new Date(Number.NaN)),
      }))
    expect((await app.fetch(new Request("http://t/number"))).status).toBe(200)
    for (const path of ["/wrong", "/invalid"])
      expect((await app.fetch(new Request(`http://t${path}`))).status).toBe(500)
    const violations = records.filter((r) => r.message === "response contract violation")
    expect(violations.map((r) => String(r.detail))).toEqual([
      expect.stringContaining("at: Expected number"),
      expect.stringContaining("createdAt: Expected string"),
    ])
  })

  test("a schema without its JSON Schema is shown the Date, so z.date() still passes", async () => {
    const app = server({ logger: silentLogger })
      .use(responseContract("enforce"))
      .get("/z", { response: z.object({ at: z.date() }) }, () => ({ at: AT }))
    const res = await app.fetch(new Request("http://t/z"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ at: ISO })
  })
})

describe("a reply that does not come from the handler's return", () => {
  test("a thrown c.json reply is held to the contract", async () => {
    const app = server({ logger: silentLogger })
      .use(responseContract("enforce"))
      .get("/me", { response: STRIPPING }, (c) => {
        throw c.json(LEAK, { status: 201, headers: { "x-request": "r1" } })
      })
      .get("/missing", { errors: { 404: STRIPPING } }, (c) => {
        throw c.json(LEAK, 404)
      })
      .get("/strict", { response: STRICT }, (c) => {
        throw c.json(LEAK)
      })
    const res = await app.fetch(new Request("http://t/me"))
    expect(res.status).toBe(201)
    expect(res.headers.get("x-request")).toBe("r1")
    expect(await res.json()).toEqual({ id: "u1", name: "Ada" })
    const missing = await app.fetch(new Request("http://t/missing"))
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ id: "u1", name: "Ada" })
    const strict = await app.fetch(new Request("http://t/strict"))
    expect(strict.status).toBe(500)
    expect(await strict.text()).not.toContain("SECRET")
  })

  test("a thrown raw Response still passes as control flow", async () => {
    const app = server()
      .use(responseContract("enforce"))
      .get("/go", { response: STRICT }, () => {
        throw new Response(null, { status: 302, headers: { location: "/" } })
      })
    const res = await app.fetch(new Request("http://t/go"))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/")
  })

  test("a c.json or status() reply from onError is held to the contract", async () => {
    const app = server()
      .use(responseContract("enforce"))
      .onError((_err, c) => c.json(LEAK, 404))
      .get("/json", { errors: { 404: STRIPPING } }, () => {
        throw new Error("boom")
      })
    const viaStatus = server()
      .use(responseContract("enforce"))
      .onError(() => status(409, LEAK))
      .get("/status", { errors: { 409: STRIPPING } }, () => {
        throw new Error("boom")
      })
    const res = await app.fetch(new Request("http://t/json"))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ id: "u1", name: "Ada" })
    const conflict = await viaStatus.fetch(new Request("http://t/status"))
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({ id: "u1", name: "Ada" })
  })

  test("a schema that throws on an onError reply answers 500 without re-entering onError", async () => {
    const throwing: StandardSchemaV1<unknown, unknown> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => {
          throw new Error("schema exploded")
        },
      },
    }
    let calls = 0
    const app = server({ logger: silentLogger })
      .use(responseContract("enforce"))
      .onError((_err, c) => {
        calls++
        return c.json(LEAK, 404)
      })
      .get("/x", { errors: { 404: throwing } }, () => {
        throw new Error("boom")
      })
    const res = await app.fetch(new Request("http://t/x"))
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain("SECRET")
    expect(calls).toBe(1)
  })

  test("a hook's c.json or status() reply is held to the contract", async () => {
    const before = server()
      .use(responseContract("enforce"))
      .beforeHandle((c) => c.json(LEAK))
      .get("/b", { response: STRIPPING }, () => ({ id: "x", name: "y" }))
    const derived = server()
      .use(responseContract("enforce"))
      .derive(async () => status(403, LEAK))
      .get("/d", { response: STRIPPING, errors: { 403: STRIPPING } }, () => ({
        id: "x",
        name: "y",
      }))
    const b = await before.fetch(new Request("http://t/b"))
    expect(b.status).toBe(200)
    expect(await b.json()).toEqual({ id: "u1", name: "Ada" })
    const d = await derived.fetch(new Request("http://t/d"))
    expect(d.status).toBe(403)
    expect(await d.json()).toEqual({ id: "u1", name: "Ada" })
  })

  test("warn mode serves a thrown c.json unchanged and names the undeclared fields", async () => {
    const { logger, records } = recorder()
    const app = server({ logger })
      .use(responseContract("warn"))
      .get("/me", { response: STRIPPING }, (c) => {
        throw c.json(LEAK)
      })
    const res = await app.fetch(new Request("http://t/me"))
    expect(await res.json()).toEqual(LEAK)
    expect(records.some((r) => String(r.detail).includes("passwordHash"))).toBe(true)
  })
})

/**
 * A `t` schema is closed by default, so plain enforcement turns an extra field into a 500. The schema
 * also carries its JSON Schema, which - unlike Standard Schema - lists the declared keys, so
 * `extra: "strip"` can project the payload onto them before validating.
 */
describe('responseContract: extra "strip"', () => {
  const strip = (mode: "warn" | "enforce", logger: Logger = silentLogger) =>
    server({ logger }).use(responseContract(mode, { extra: "strip" }))
  const fetchJson = async (app: AnyServer, path: string) => {
    const res = await app.fetch(new Request(`http://t${path}`))
    return { status: res.status, body: await res.text() }
  }
  /** A schema carrying `jsonSchema` whose validator accepts anything, so the projection alone shows. */
  const passthrough = (jsonSchema: object): StandardSchemaV1 =>
    Object.assign(
      {
        "~standard": {
          version: 1 as const,
          vendor: "test",
          validate: (value: unknown) => ({ value }),
        },
      },
      { jsonSchema },
    )

  test("a closed t.object serves only its declared fields", async () => {
    const res = await fetchJson(
      strip("enforce").get("/me", { response: STRICT }, () => LEAK),
      "/me",
    )
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ id: "u1", name: "Ada" })
    expect(res.body).not.toContain("SECRET")
  })

  test("a field declared as __proto__ is sent as a field, never set as the prototype", async () => {
    const declared = JSON.parse(
      '{"type":"object","additionalProperties":false,"properties":{"__proto__":{"type":"object","additionalProperties":false,"properties":{"role":{"type":"string"}}},"id":{"type":"string"}}}',
    )
    const app = strip("enforce").get("/me", { response: passthrough(declared) }, () =>
      JSON.parse('{"__proto__":{"role":"user","admin":true},"id":"u1","secret":"SECRET"}'),
    )
    const res = await fetchJson(app, "/me")
    expect(res.status).toBe(200)
    expect(res.body).toBe('{"__proto__":{"role":"user"},"id":"u1"}')
  })

  test("projects nested objects, arrays, records and a nullable union", async () => {
    const shape = t.object({
      user: STRICT,
      list: t.array(STRICT),
      byId: t.record(STRICT),
      maybe: t.union([STRICT, t.null()]),
      none: t.union([STRICT, t.null()]),
    })
    const app = strip("enforce").get("/n", { response: shape }, () => ({
      user: LEAK,
      list: [LEAK, LEAK],
      byId: { a: LEAK },
      maybe: LEAK,
      none: null,
      extra: "SECRET",
    }))
    const res = await fetchJson(app, "/n")
    const clean = { id: "u1", name: "Ada" }
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      user: clean,
      list: [clean, clean],
      byId: { a: clean },
      maybe: clean,
      none: null,
    })
  })

  test("a closed record keeps every key its pattern admits", async () => {
    // Primitive values need no projection; the record still must not collapse to `{}`.
    const shape = t.object({
      labels: t.record(t.string(), { additionalProperties: false }),
      tags: t.record(t.array(t.string()), { additionalProperties: false }),
      users: t.record(STRICT, { additionalProperties: false }),
      open: t.record(t.string()),
    })
    const app = strip("enforce").get("/r", { response: shape }, () => ({
      labels: { one: "valid", two: "also-valid" },
      tags: { x: ["1", "2"] },
      users: { a: LEAK },
      open: { k: "v" },
    }))
    const res = await fetchJson(app, "/r")
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      labels: { one: "valid", two: "also-valid" },
      tags: { x: ["1", "2"] },
      users: { a: { id: "u1", name: "Ada" } },
      open: { k: "v" },
    })
  })

  test("a closed object drops keys no pattern admits and copies a key two patterns match", async () => {
    const schema = passthrough({
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string" } },
      patternProperties: {
        "^x-": {
          type: "object",
          properties: { keep: { type: "string" } },
          additionalProperties: false,
        },
        "^x-both$": { type: "object" },
      },
    })
    const row = { keep: "k", drop: "d" }
    const outcome = await checkResponseContract(
      schema,
      { id: "1", "x-one": row, "x-both": row, other: "gone" },
      "enforce",
      { extra: "strip" },
    )
    expect(outcome).toEqual({
      kind: "ok",
      value: { id: "1", "x-one": { keep: "k" }, "x-both": row },
    })
  })

  test("a pattern the engine cannot compile leaves the value to the validator", async () => {
    const schema = passthrough({
      type: "object",
      additionalProperties: false,
      patternProperties: { "(": { type: "string" } },
    })
    const value = { a: "kept", b: "kept" }
    expect(await checkResponseContract(schema, value, "enforce", { extra: "strip" })).toEqual({
      kind: "ok",
      value,
    })
  })

  test("an open object keeps its extras but still projects a closed child", async () => {
    const shape = t.looseObject({ user: STRICT })
    const app = strip("enforce").get("/o", { response: shape }, () => ({
      user: LEAK,
      note: "kept",
    }))
    expect(JSON.parse((await fetchJson(app, "/o")).body)).toEqual({
      user: { id: "u1", name: "Ada" },
      note: "kept",
    })
  })

  test("a union of two object shapes is left to the validator", async () => {
    // Projecting onto either branch could strip the fields that make the other one match.
    const other = t.object({ id: t.string(), email: t.string() })
    const app = strip("enforce").get("/u", { response: t.union([STRICT, other]) }, () => LEAK)
    expect((await fetchJson(app, "/u")).status).toBe(500)
  })

  describe("a union told apart by a required literal", () => {
    const Result = t.union([
      t.object({ ok: t.literal(true), data: STRICT }),
      t.object({ ok: t.literal(false), error: t.object({ code: t.string() }) }),
    ])

    test("projects each value onto the branch its tag names", async () => {
      const app = strip("enforce")
        .get("/yes", { response: Result }, () => ({ ok: true, data: LEAK, trace: "SECRET" }))
        .get("/no", { response: Result }, () => ({
          ok: false,
          error: { code: "gone", stack: "SECRET" },
          data: LEAK,
        }))
      const yes = await fetchJson(app, "/yes")
      const no = await fetchJson(app, "/no")
      expect([yes.status, no.status]).toEqual([200, 200])
      expect(JSON.parse(yes.body)).toEqual({ ok: true, data: { id: "u1", name: "Ada" } })
      expect(JSON.parse(no.body)).toEqual({ ok: false, error: { code: "gone" } })
    })

    test("a string tag over three branches, one of them a union of literals", async () => {
      const Job = t.union([
        t.object({
          state: t.union([t.literal("queued"), t.literal("running")]),
          id: t.string(),
        }),
        t.object({ state: t.literal("done"), id: t.string(), output: t.string() }),
        t.object({ state: t.literal("failed"), id: t.string(), reason: t.string() }),
      ])
      const app = strip("enforce").get("/jobs", { response: t.array(Job) }, () => [
        { state: "running", id: "j1", worker: "SECRET" },
        { state: "done", id: "j2", output: "ok", worker: "SECRET" },
        { state: "failed", id: "j3", reason: "timeout", worker: "SECRET" },
      ])
      const res = await fetchJson(app, "/jobs")
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body)).toEqual([
        { state: "running", id: "j1" },
        { state: "done", id: "j2", output: "ok" },
        { state: "failed", id: "j3", reason: "timeout" },
      ])
    })

    test("arrays and objects are routed to their own branches, null passes", async () => {
      const shape = t.object({
        one: t.union([STRICT, t.array(STRICT), t.null()]),
        many: t.union([STRICT, t.array(STRICT), t.null()]),
        none: t.union([STRICT, t.array(STRICT), t.null()]),
      })
      const app = strip("enforce").get("/m", { response: shape }, () => ({
        one: LEAK,
        many: [LEAK],
        none: null,
      }))
      const clean = { id: "u1", name: "Ada" }
      expect(JSON.parse((await fetchJson(app, "/m")).body)).toEqual({
        one: clean,
        many: [clean],
        none: null,
      })
    })

    test("a tag read through a row class getter selects the branch", async () => {
      class Found {
        data = LEAK
        secret = "SECRET"
        get ok(): true {
          return true
        }
      }
      const app = strip("enforce").get("/g", { response: Result }, () => new Found())
      expect(JSON.parse((await fetchJson(app, "/g")).body)).toEqual({
        ok: true,
        data: { id: "u1", name: "Ada" },
      })
    })

    test("tags two branches share leave the union to the validator", async () => {
      const Shared = t.union([
        t.object({ ok: t.literal(true), id: t.string() }),
        t.object({ ok: t.literal(true), name: t.string() }),
      ])
      const app = strip("enforce").get("/s", { response: Shared }, () => ({ ...LEAK, ok: true }))
      expect((await fetchJson(app, "/s")).status).toBe(500)
    })

    test("an optional tag leaves the union to the validator", async () => {
      const Loose = t.union([
        t.object({ ok: t.optional(t.literal(true)), data: STRICT }),
        t.object({ ok: t.literal(false), error: t.string() }),
      ])
      const app = strip("enforce").get("/o", { response: Loose }, () => ({
        ok: true,
        data: LEAK,
        extra: 1,
      }))
      expect((await fetchJson(app, "/o")).status).toBe(500)
    })

    test("a tag no branch names is refused, never projected onto another branch", async () => {
      // Parsed, so the value can break the contract the handler's type would otherwise enforce.
      const app = strip("enforce").get("/x", { response: Result }, () =>
        JSON.parse('{"ok":"maybe","data":{"id":"u1","name":"Ada","resetToken":"tok"}}'),
      )
      expect((await fetchJson(app, "/x")).status).toBe(500)
    })

    test("a branch that could hold anything stops the projection", async () => {
      const schema = passthrough({
        anyOf: [
          {
            type: "object",
            required: ["k"],
            properties: { k: { const: "a" } },
            additionalProperties: false,
          },
          {},
        ],
      })
      const value = { k: "a", extra: "kept" }
      expect(await checkResponseContract(schema, value, "enforce", { extra: "strip" })).toEqual({
        kind: "ok",
        value,
      })
    })
  })

  test("a declared getter on a row class is read", async () => {
    class Row {
      id = "u1"
      secret = "SECRET"
      get name(): string {
        return "Ada"
      }
    }
    const app = strip("enforce").get("/c", { response: STRICT }, () => new Row())
    expect(JSON.parse((await fetchJson(app, "/c")).body)).toEqual({ id: "u1", name: "Ada" })
  })

  test("warn names the fields strip would drop and serves the payload unchanged", async () => {
    const { logger, records } = recorder()
    const res = await fetchJson(
      strip("warn", logger).get("/me", { response: STRICT }, () => LEAK),
      "/me",
    )
    expect(JSON.parse(res.body)).toEqual(LEAK)
    const detail = String(records.find((r) => r.message === "response contract")?.detail)
    expect(detail).toContain("passwordHash, resetToken")
  })

  test("a schema without jsonSchema keeps its own semantics", async () => {
    const res = await fetchJson(
      strip("enforce").get("/z", { response: STRIPPING }, () => LEAK),
      "/z",
    )
    expect(JSON.parse(res.body)).toEqual({ id: "u1", name: "Ada" })
  })

  test("an unknown extra mode is refused when the plugin is built", () => {
    expect(() => responseContract("enforce", JSON.parse('{"extra":"drop"}'))).toThrow(TypeError)
  })
})

describe("responseContract: logStripped", () => {
  const logged = (records: LogFields[]) =>
    records.filter((r) => r.message === "response contract").map((r) => String(r.detail))
  const app = (logger: Logger, options: Parameters<typeof responseContract>[1]) =>
    server({ logger }).use(responseContract("enforce", options))
  const hit = async (target: AnyServer, path: string) =>
    (await target.fetch(new Request(`http://t${path}`))).text()

  test("names what was stripped, nested and per item, once per route and set", async () => {
    const { logger, records } = recorder()
    const shape = t.object({ user: STRICT, list: t.array(STRICT) })
    const target = app(logger, { extra: "strip", logStripped: true }).get(
      "/n",
      { response: shape },
      () => ({ user: LEAK, list: [LEAK, { id: "u2", name: "Bo", rank: 1 }], extra: true }),
    )
    const body = await hit(target, "/n")
    await hit(target, "/n")
    expect(JSON.parse(body).user).toEqual({ id: "u1", name: "Ada" })
    expect(logged(records)).toEqual([
      "response carried fields its contract does not declare: extra, list[].passwordHash, list[].rank, list[].resetToken, user.passwordHash, user.resetToken. They were not sent.",
    ])
  })

  test("never logs a value", async () => {
    const { logger, records } = recorder()
    const target = app(logger, { extra: "strip", logStripped: true }).get(
      "/me",
      { response: STRICT },
      () => LEAK,
    )
    await hit(target, "/me")
    expect(JSON.stringify(records)).not.toContain("SECRET")
  })

  test("a new set on the same route is logged, and each route keeps its own", async () => {
    const { logger, records } = recorder()
    let extra: Record<string, string> = { a: "1" }
    const target = app(logger, { extra: "strip", logStripped: true })
      .get("/one", { response: STRICT }, () => ({ id: "u1", name: "Ada", ...extra }))
      .get("/two", { response: STRICT }, () => ({ id: "u1", name: "Ada", a: "1" }))
    await hit(target, "/one")
    extra = { b: "2" }
    await hit(target, "/one")
    await hit(target, "/two")
    expect(logged(records).map((line) => line.split(": ")[1])).toEqual([
      "a. They were not sent.",
      "b. They were not sent.",
      "a. They were not sent.",
    ])
  })

  test("a schema that strips on its own is reported too", async () => {
    const { logger, records } = recorder()
    const target = app(logger, { logStripped: true }).get("/z", { response: STRIPPING }, () => LEAK)
    await hit(target, "/z")
    expect(logged(records)[0]).toContain("passwordHash, resetToken")
  })

  test("is quiet without the option and when nothing was stripped", async () => {
    const { logger, records } = recorder()
    await hit(
      app(logger, { extra: "strip" }).get("/a", { response: STRICT }, () => LEAK),
      "/a",
    )
    await hit(
      app(logger, { extra: "strip", logStripped: true }).get("/b", { response: STRICT }, () => ({
        id: "u1",
        name: "Ada",
      })),
      "/b",
    )
    expect(logged(records)).toEqual([])
  })

  test("lists at most twenty names, and long names are cut", async () => {
    const { logger, records } = recorder()
    const wide = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`f${String(i).padStart(2, "0")}`, i]),
    )
    const long = "k".repeat(100)
    const target = app(logger, { extra: "strip", logStripped: true })
      .get("/wide", { response: STRICT }, () => ({ id: "u1", name: "Ada", ...wide }))
      .get("/long", { response: STRICT }, () => ({ id: "u1", name: "Ada", [long]: 1 }))
    await hit(target, "/wide")
    await hit(target, "/long")
    const [many, cut] = logged(records)
    expect(many).toContain("f19, and more.")
    expect(many).not.toContain("f20")
    expect(cut).toContain(`${"k".repeat(64)}...`)
    expect(cut).not.toContain("k".repeat(65))
  })

  test("stops after 32 sets on one route and says so", async () => {
    const { logger, records } = recorder()
    let n = 0
    const target = app(logger, { extra: "strip", logStripped: true }).get(
      "/many",
      { response: STRICT },
      () => ({ id: "u1", name: "Ada", [`x${n++}`]: 1 }),
    )
    for (let i = 0; i < 40; i++) await hit(target, "/many")
    const lines = logged(records)
    expect(lines).toHaveLength(32)
    expect(lines[31]).toContain("Further sets of fields on this route are not logged.")
  })

  test("an asynchronous validator is reported the same way", async () => {
    const { logger, records } = recorder()
    const slow: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async (value: unknown) => ({ value: { id: Reflect.get(Object(value), "id") } }),
      },
    }
    const target = app(logger, { logStripped: true }).get("/s", { response: slow }, () => LEAK)
    expect(JSON.parse(await hit(target, "/s"))).toEqual({ id: "u1" })
    expect(logged(records)[0]).toContain("name, passwordHash, resetToken")
  })

  test("warn mode keeps its own report and logStripped adds nothing", async () => {
    const { logger, records } = recorder()
    const target = server({ logger })
      .use(responseContract("warn", { extra: "strip", logStripped: true }))
      .get("/w", { response: STRICT }, () => LEAK)
    await hit(target, "/w")
    expect(logged(records)).toHaveLength(1)
    expect(logged(records)[0]).toContain("They are being sent")
  })

  test("a non-boolean logStripped is refused when the plugin is built", () => {
    expect(() => responseContract("enforce", JSON.parse('{"logStripped":"yes"}'))).toThrow(
      TypeError,
    )
  })
})

describe("responseContract: onReport", () => {
  const collect = () => {
    const reports: ResponseContractReport[] = []
    return { reports, onReport: (report: ResponseContractReport) => void reports.push(report) }
  }
  const hit = async (target: AnyServer, path: string) => {
    const res = await target.fetch(new Request(`http://t${path}`))
    return { status: res.status, body: await res.text() }
  }

  test("reports every stripped response with its route pattern, never a value, and logs nothing", async () => {
    const { logger, records } = recorder()
    const { reports, onReport } = collect()
    const target = server({ logger })
      .use(responseContract("enforce", { extra: "strip", onReport }))
      .get("/users/:id", { response: STRICT }, () => LEAK)
    await hit(target, "/users/7")
    await hit(target, "/users/8")
    const stripped: ResponseContractReport = {
      kind: "stripped",
      method: "GET",
      route: "/users/:id",
      fields: ["passwordHash", "resetToken"],
      message:
        "response carried fields its contract does not declare: passwordHash, resetToken. They were not sent.",
    }
    expect(reports).toEqual([stripped, stripped])
    expect(JSON.stringify(reports)).not.toContain("SECRET")
    expect(records).toEqual([])
  })

  test("a violation is reported and the 500 still goes out", async () => {
    const { reports, onReport } = collect()
    const target = server({ logger: silentLogger })
      .use(responseContract("enforce", { onReport }))
      .get("/me", { response: STRICT }, () => LEAK)
    expect((await hit(target, "/me")).status).toBe(500)
    expect(reports.map(({ kind, route }) => [kind, route])).toEqual([["violation", "/me"]])
    expect(reports[0]?.message).toStartWith("response does not satisfy its declared contract")
  })

  test("warn mode reports what it sent anyway, naming undeclared keys when they are the reason", async () => {
    const { reports, onReport } = collect()
    const target = server({ logger: silentLogger })
      .use(responseContract("warn", { onReport }))
      .get("/strict", { response: STRICT }, () => LEAK)
      .get("/loose", { response: STRIPPING }, () => LEAK)
    expect(JSON.parse((await hit(target, "/loose")).body)).toEqual(LEAK)
    await hit(target, "/strict")
    expect(reports.map(({ kind, route, fields }) => [kind, route, fields])).toEqual([
      ["warn", "/loose", ["passwordHash", "resetToken"]],
      ["warn", "/strict", undefined],
    ])
  })

  test("names a group's route and a merged server's route by their own pattern", async () => {
    const { reports, onReport } = collect()
    const users = server().get("/users/:id", { response: STRIPPING }, () => LEAK)
    const target = server({ logger: silentLogger })
      .use(responseContract("enforce", { onReport }))
      .group("/v1", (v1) => v1.get("/orders/:id", { response: STRIPPING }, () => LEAK))
      .merge(users)
    await hit(target, "/v1/orders/1")
    await hit(target, "/users/2")
    expect(reports.map(({ method, route }) => `${method} ${route}`)).toEqual([
      "GET /v1/orders/:id",
      "GET /users/:id",
    ])
  })

  test("an asynchronous validator is reported the same way", async () => {
    const { reports, onReport } = collect()
    const slow: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async (value: unknown) => ({ value: { id: Reflect.get(Object(value), "id") } }),
      },
    }
    const target = server({ logger: silentLogger })
      .use(responseContract("enforce", { onReport }))
      .get("/s", { response: slow }, () => LEAK)
    expect(JSON.parse((await hit(target, "/s")).body)).toEqual({ id: "u1" })
    expect(reports[0]?.fields).toEqual(["name", "passwordHash", "resetToken"])
  })

  test("a hook that throws or rejects is logged once and changes no response", async () => {
    for (const onReport of [
      () => {
        throw new Error("metrics down")
      },
      () => Promise.reject(new Error("metrics down")),
    ]) {
      const { logger, records } = recorder()
      const target = server({ logger })
        .use(responseContract("enforce", { extra: "strip", onReport }))
        .get("/me", { response: STRICT }, () => LEAK)
      for (let i = 0; i < 2; i++) {
        const res = await hit(target, "/me")
        expect([res.status, JSON.parse(res.body)]).toEqual([200, { id: "u1", name: "Ada" }])
      }
      await Promise.resolve()
      expect(records).toEqual([
        { message: "response contract onReport threw", detail: "Error: metrics down" },
      ])
    }
  })

  test("without a hook or logStripped, the payload is not walked", async () => {
    let walked = 0
    const payload = () =>
      new Proxy(
        { ...LEAK },
        {
          ownKeys: (target) => {
            walked++
            return Reflect.ownKeys(target)
          },
        },
      )
    const plain = server({ logger: silentLogger })
      .use(responseContract("enforce", { extra: "strip" }))
      .get("/me", { response: STRICT }, payload)
    await hit(plain, "/me")
    expect(walked).toBe(0)
    const { onReport } = collect()
    const reported = server({ logger: silentLogger })
      .use(responseContract("enforce", { extra: "strip", onReport }))
      .get("/me", { response: STRICT }, payload)
    await hit(reported, "/me")
    expect(walked).toBeGreaterThan(0)
  })

  test("a hook that is not a function is logged once, like one that throws", async () => {
    const { logger, records } = recorder()
    const target = server({ logger })
      .use(responseContract("enforce", JSON.parse('{"extra":"strip","onReport":"count"}')))
      .get("/me", { response: STRICT }, () => LEAK)
    expect((await hit(target, "/me")).status).toBe(200)
    await hit(target, "/me")
    expect(records.map((record) => record.message)).toEqual(["response contract onReport threw"])
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

  test("a schema with a JSON Schema is shown each Date as the string it writes", () => {
    const AT = new Date(0)
    const ISO = AT.toISOString()
    // A schema that accepts anything shows what it was handed.
    const spy: StandardSchemaV1 = {
      "~standard": { version: 1, vendor: "test", validate: (input) => ({ value: input }) },
    }
    const judged = (schema: StandardSchemaV1, value: unknown): unknown => {
      const outcome = checkResponseContract(schema, value, "enforce")
      return "value" in outcome ? outcome.value : outcome
    }
    const described = { ...spy, jsonSchema: { type: "object" } }
    expect(judged(described, { a: AT, b: [AT], c: { d: AT } })).toEqual({
      a: ISO,
      b: [ISO],
      c: { d: ISO },
    })
    const text = { ...spy, jsonSchema: { type: "string" } }
    expect(judged(text, AT)).toBe(ISO)
    // Nothing says how a schema without one reads a Date, so it is handed the Date.
    expect(judged(spy, { a: AT })).toEqual({ a: AT })
  })

  test("a t.date() place takes the RFC 3339 string a Date is written as, and sends it on", async () => {
    const schema = t.object({ at: t.date(), maybe: t.union([t.date(), t.null()]) })
    for (const sent of [
      { at: "2026-10-25T12:00:00.000Z", maybe: null },
      { at: "2026-10-25T14:00:00+02:00", maybe: "2026-10-25T12:00:00Z" },
    ])
      expect(await checkResponseContract(schema, sent, "enforce")).toEqual({
        kind: "ok",
        value: sent,
      })
    for (const at of ["2026-02-30T00:00:00Z", "2026-10-25 12:00:00Z", "2026-10-25T12:00:00", "1"])
      expect(await checkResponseContract(schema, { at, maybe: null }, "enforce")).toMatchObject({
        kind: "violation",
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
    const running = app.listen(0, { hostname: "127.0.0.1" })
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
    const running = app.listen(0, { hostname: "127.0.0.1" })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/me`)
      expect(await res.json()).toEqual(LEAK)
    } finally {
      await running.stop()
    }
  })
})
