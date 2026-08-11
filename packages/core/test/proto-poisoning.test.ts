import { describe, expect, test } from "bun:test"
import { server } from "../src/index.ts"
import type { StandardResult, StandardSchemaV1, StandardTypes } from "../src/schema/standard.ts"
import { parseJsonGuarded } from "../src/server/proto-guard.ts"

/**
 * The JSON body lane must not hand handlers a value that poisons prototypes downstream.
 * `JSON.parse` itself is safe - it creates `__proto__` as an own DATA property
 * (CreateDataProperty, never the setter) - the danger is any later merge/assign copying that key
 * onto a real prototype. Text-in-hand lanes pre-scan for suspect substrings and deep-walk only on
 * a hit; the native-json() fast path walks the parsed value directly. Policy: `"reject"` (default)
 * answers the same flat 400 as malformed JSON, `"strip"` deletes the keys in place, `"ignore"`
 * opts out.
 */
describe("parseJsonGuarded - policy matrix", () => {
  test("reject: own __proto__ at the top level throws", () => {
    expect(() => parseJsonGuarded('{"__proto__": {"admin": true}}', "reject")).toThrow()
  })

  test("reject: nested and array-wrapped __proto__ throw", () => {
    expect(() => parseJsonGuarded('{"a": {"b": {"__proto__": {"x": 1}}}}', "reject")).toThrow()
    expect(() => parseJsonGuarded('[1, [{"__proto__": {"x": 1}}]]', "reject")).toThrow()
  })

  test('reject: "__proto__" as a string VALUE is legal data', () => {
    expect(parseJsonGuarded('{"a": "__proto__"}', "reject")).toEqual({ a: "__proto__" })
    expect(parseJsonGuarded('["__proto__", "constructor"]', "reject")).toEqual([
      "__proto__",
      "constructor",
    ])
  })

  test("reject: constructor.prototype is the poisoning shape; benign constructor is not", () => {
    expect(() =>
      parseJsonGuarded('{"constructor": {"prototype": {"isAdmin": true}}}', "reject"),
    ).toThrow()
    // A constructor key whose value is not an object carrying `prototype` is ordinary data.
    expect(parseJsonGuarded('{"constructor": "Ford"}', "reject")).toEqual({ constructor: "Ford" })
    expect(parseJsonGuarded('{"constructor": {"name": "y"}}', "reject")).toEqual({
      constructor: { name: "y" },
    })
  })

  test("reject: \\u-escaped spelling of __proto__ cannot slip past the pre-scan", () => {
    // `_` is `_`: the quoted-substring scan misses, but any `\u` in the text routes to the
    // walk (unicode escapes are the only JSON mechanism that can spell identifier characters).
    expect(() =>
      parseJsonGuarded('{"\\u005f\\u005fproto\\u005f\\u005f": {"x": 1}}', "reject"),
    ).toThrow()
    expect(() =>
      parseJsonGuarded('{"con\\u0073tructor": {"prototype": {"x": 1}}}', "reject"),
    ).toThrow()
  })

  test("reject: a clean payload that merely contains \\u escapes passes through the walk", () => {
    expect(parseJsonGuarded('{"caf\\u00e9": 1}', "reject")).toEqual({ café: 1 })
  })

  test("strip: poisoned keys are deleted in place, siblings survive", () => {
    const value = parseJsonGuarded(
      '{"name": "Ada", "__proto__": {"admin": true}, "nested": {"constructor": {"prototype": {}}, "keep": 1}}',
      "strip",
    ) as Record<string, unknown>
    expect(Object.hasOwn(value, "__proto__")).toBe(false)
    expect(value.name).toBe("Ada")
    const nested = value.nested as Record<string, unknown>
    expect(Object.hasOwn(nested, "constructor")).toBe(false)
    expect(nested.keep).toBe(1)
    // The value's real prototype was never touched.
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
    expect({} as { admin?: boolean }).not.toHaveProperty("admin")
  })

  test("strip: benign constructor data survives the sweep", () => {
    expect(parseJsonGuarded('{"constructor": "Ford"}', "strip")).toEqual({ constructor: "Ford" })
  })

  test("ignore: the parsed value passes through with the own key intact", () => {
    const value = parseJsonGuarded('{"__proto__": {"admin": true}}', "ignore") as object
    expect(Object.hasOwn(value, "__proto__")).toBe(true)
    // JSON.parse created it as an own data property; the prototype chain is untouched.
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
  })

  test("adversarial nesting does not blow the call stack (iterative walk)", () => {
    const depth = 10_000
    const text = `${'{"a":'.repeat(depth)}{"__proto__":{"x":1}}${"}".repeat(depth)}`
    expect(() => parseJsonGuarded(text, "reject")).toThrow()
    const stripped = parseJsonGuarded(text, "strip")
    expect(stripped).toBeDefined()
  })
})

function schema<Output>(
  validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>,
): StandardSchemaV1<unknown, Output> {
  return {
    "~standard": {
      version: 1,
      vendor: "nifra-test",
      validate,
      types: undefined as unknown as StandardTypes<unknown, Output>,
    },
  }
}

/** Passthrough schema: hands the parsed (post-guard) value straight to the handler. */
const anyBody = schema<unknown>((value) => ({ value }))

const POISONED = '{"name": "Ada", "__proto__": {"admin": true}}'

/** A POST with an explicit Content-Length matching the payload - the buffered fast path. */
function lengthedRequest(path: string, payload: string): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(payload).length),
    },
    body: payload,
  })
}

/** A POST whose body is a ReadableStream - no Content-Length, the streaming drain path. */
function streamRequest(path: string, payload: string): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(payload))
      c.close()
    },
  })
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
  })
}

describe("protoPoisoning end to end (schema lane + c.boundedJson)", () => {
  test("default reject: poisoned body answers the same flat 400 as malformed JSON", async () => {
    let ran = false
    const app = server().post("/users", { body: anyBody }, () => {
      ran = true
      return { ok: true }
    })
    const poisoned = await app.fetch(lengthedRequest("/users", POISONED))
    expect(poisoned.status).toBe(400)
    const malformed = await app.fetch(lengthedRequest("/users", "{not json"))
    expect(malformed.status).toBe(400)
    // Indistinguishable on the wire: an attacker learns nothing from the response shape.
    expect(await poisoned.json()).toEqual(await malformed.json())
    expect(ran).toBe(false)
  })

  test("default reject holds on the streaming (no Content-Length) path too", async () => {
    const app = server().post("/users", { body: anyBody }, () => ({ ok: true }))
    expect((await app.fetch(streamRequest("/users", POISONED))).status).toBe(400)
  })

  test("large framed bodies cross the prescan sub-lane with the same policy surface", async () => {
    // Past the size split the framed path buffers text and prescans it instead of walking the
    // parsed value - same flat 400 on poison, same clean passthrough as the small sub-lane.
    const pad = "x".repeat(2000)
    const app = server().post("/users", { body: anyBody }, (c) => ({
      name: (c.body as { name?: unknown }).name,
    }))
    const poisoned = `{"pad": "${pad}", "name": "Ada", "__proto__": {"admin": true}}`
    expect((await app.fetch(lengthedRequest("/users", poisoned))).status).toBe(400)
    const clean = await app.fetch(lengthedRequest("/users", `{"pad": "${pad}", "name": "Ada"}`))
    expect(clean.status).toBe(200)
    expect(await clean.json()).toEqual({ name: "Ada" })
  })

  test("strip cleans a large framed body through the prescan sub-lane", async () => {
    const pad = "x".repeat(2000)
    const app = server({ protoPoisoning: "strip" }).post("/users", { body: anyBody }, (c) => {
      const body = c.body as Record<string, unknown>
      return { name: body.name, hasProto: Object.hasOwn(body, "__proto__") }
    })
    const payload = `{"pad": "${pad}", "name": "Ada", "__proto__": {"admin": true}}`
    const res = await app.fetch(lengthedRequest("/users", payload))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: "Ada", hasProto: false })
  })

  test("strip: the handler sees the cleaned value, data intact", async () => {
    const app = server({ protoPoisoning: "strip" }).post("/users", { body: anyBody }, (c) => {
      const body = c.body as Record<string, unknown>
      return { name: body.name, hasProto: Object.hasOwn(body, "__proto__") }
    })
    const res = await app.fetch(lengthedRequest("/users", POISONED))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ name: "Ada", hasProto: false })
  })

  test("ignore: the raw parsed value reaches the handler", async () => {
    const app = server({ protoPoisoning: "ignore" }).post("/users", { body: anyBody }, (c) => ({
      hasProto: Object.hasOwn(c.body as object, "__proto__"),
    }))
    const res = await app.fetch(lengthedRequest("/users", POISONED))
    expect(await res.json()).toEqual({ hasProto: true })
  })

  test("c.boundedJson enforces the same default rejection", async () => {
    let ran = false
    const app = server().post("/raw", async (c) => {
      const body = await c.boundedJson()
      ran = true
      return body
    })
    expect((await app.fetch(lengthedRequest("/raw", POISONED))).status).toBe(400)
    expect(ran).toBe(false)
  })

  test("c.boundedJson honours the server strip policy", async () => {
    const app = server({ protoPoisoning: "strip" }).post("/raw", async (c) => {
      const body = (await c.boundedJson()) as Record<string, unknown>
      return { name: body.name, hasProto: Object.hasOwn(body, "__proto__") }
    })
    expect(await (await app.fetch(lengthedRequest("/raw", POISONED))).json()).toEqual({
      name: "Ada",
      hasProto: false,
    })
  })

  test("\\u-escaped __proto__ is rejected end to end (escape-soundness regression)", async () => {
    const app = server().post("/users", { body: anyBody }, () => ({ ok: true }))
    const escaped = '{"\\u005f\\u005fproto\\u005f\\u005f": {"admin": true}}'
    expect((await app.fetch(lengthedRequest("/users", escaped))).status).toBe(400)
    expect((await app.fetch(streamRequest("/users", escaped))).status).toBe(400)
  })

  test("the transport-codec lane enforces the same policy on its own decoder", async () => {
    // The codec lane parses with codec.decode and stashes the value past the body lane's guard,
    // so it must run the guard itself - a poisoned rich-wire payload answers the same flat 400
    // as an undecodable one.
    const { richWireCodec } = await import("../src/transport-codec-rich.ts")
    const { plainJsonCodec, createTransportCodecRegistry } = await import(
      "../src/transport-codec.ts"
    )
    const { transportCodecs } = await import("../src/transport-plugin.ts")
    const rich = richWireCodec()
    const registry = createTransportCodecRegistry([plainJsonCodec, rich])
    const app = server()
      .use(transportCodecs(registry))
      .post("/echo", { body: anyBody }, (c) => c.body)
    // Valid wire framing whose decoded object carries an own __proto__ key - the wire decoder
    // reproduces it just like JSON.parse does, so the decode succeeds and only the guard rejects.
    const wirePoisoned =
      '{"r":{"$w":"ref","i":0},"n":[{"$w":"obj","v":{"name":"Ada","__proto__":{"$w":"ref","i":1}}},{"$w":"obj","v":{"admin":true}}]}'
    const poisoned = await app.fetch(
      new Request("http://test/echo", {
        method: "POST",
        headers: { "content-type": rich.mediaType },
        body: wirePoisoned,
      }),
    )
    expect(poisoned.status).toBe(400)
    const clean = await app.fetch(
      new Request("http://test/echo", {
        method: "POST",
        headers: { "content-type": rich.mediaType, accept: "application/json" },
        body: rich.encode({ name: "Ada" }),
      }),
    )
    expect(clean.status).toBe(200)
    expect(await clean.json()).toEqual({ name: "Ada" })
  })
})
