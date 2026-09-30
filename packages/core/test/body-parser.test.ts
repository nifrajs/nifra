import { describe, expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { server } from "../src/index.ts"
import { nodeDirect } from "../src/node-direct.ts"
import { reflectRoutes } from "../src/reflection.ts"
import type { StandardSchemaV1, StandardTypes } from "../src/schema/standard.ts"
import { bodyParser } from "../src/server/body-parser.ts"
import { multipartBody } from "../src/server/multipart.ts"

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder("utf-8", { fatal: true })

const anyBody: StandardSchemaV1<unknown, unknown> = {
  "~standard": {
    version: 1,
    vendor: "nifra-test",
    validate: (value) => ({ value }),
    types: undefined as unknown as StandardTypes<unknown, unknown>,
  },
}

/** `key: value` lines, the smallest format that is neither JSON nor a form. */
const lines = (bytes: Uint8Array): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const line of DECODER.decode(bytes).split("\n")) {
    if (line === "") continue
    const at = line.indexOf(": ")
    if (at === -1) throw new Error("not a line")
    out[line.slice(0, at)] = line.slice(at + 2)
  }
  return out
}

const YAML = "application/yaml"

function post(
  body: string | Uint8Array | ReadableStream<Uint8Array>,
  contentType: string | null = YAML,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://x/in", {
    method: "POST",
    headers: { ...(contentType === null ? {} : { "content-type": contentType }), ...headers },
    // A string body is given a content-type by the platform; bytes are sent with none.
    body: typeof body === "string" ? ENCODER.encode(body) : body,
    // A streamed request body needs the half-duplex opt-in.
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit)
}

const streamOf = (...chunks: readonly string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(ENCODER.encode(chunk))
      controller.close()
    },
  })

const errorOf = async (response: Response): Promise<[number, unknown]> => [
  response.status,
  await response.json(),
]

/** An app whose one route hands the handler whatever `parse` decoded. */
const appOf = (
  parse: (bytes: Uint8Array) => unknown,
  options?: Parameters<typeof server>[0],
  seen?: (body: unknown) => void,
) =>
  server(options).post("/in", { body: bodyParser(anyBody, { types: [YAML], parse }) }, (c) => {
    seen?.(c.body)
    return { ok: true }
  })

describe("bodyParser registration", () => {
  const parse = (): unknown => ({})
  const refused: ReadonlyArray<readonly [string, unknown]> = [
    ["no types", []],
    ["types that are not an array", "application/yaml"],
    ["a type that is not a string", [42]],
    ["a bare type", ["yaml"]],
    ["a wildcard subtype", ["application/*"]],
    ["a wildcard", ["*/*"]],
    ["a parameter", ["application/yaml; charset=utf-8"]],
    ["surrounding space", [" application/yaml"]],
    ["two types in one entry", ["application/yaml, text/yaml"]],
    ["JSON", ["application/json"]],
    ["JSON in any case", ["Application/JSON"]],
    ["a +json type", ["application/problem+json"]],
    ["urlencoded", ["application/x-www-form-urlencoded"]],
    ["urlencoded in any case", ["APPLICATION/X-WWW-FORM-URLENCODED"]],
    ["multipart", ["multipart/form-data"]],
    ["any multipart", ["multipart/mixed"]],
    ["text/plain", ["text/plain"]],
    ["text/plain in any case", ["Text/Plain"]],
  ]
  for (const [label, types] of refused) {
    test(`refuses ${label}`, () => {
      expect(() => bodyParser(anyBody, { types: types as readonly string[], parse })).toThrow(
        TypeError,
      )
    })
  }

  test("refuses a parse that is not a function", () => {
    expect(() =>
      bodyParser(anyBody, { types: [YAML], parse: "nope" as unknown as () => unknown }),
    ).toThrow(TypeError)
  })

  test("the schema it was given is not changed", () => {
    const before = Reflect.ownKeys(anyBody)
    const wrapped = bodyParser(anyBody, { types: [YAML], parse })
    expect(wrapped).not.toBe(anyBody)
    expect(Reflect.ownKeys(anyBody)).toEqual(before)
    expect(wrapped["~standard"]).toBe(anyBody["~standard"])
  })

  test("a callable schema keeps validating", async () => {
    const callable = Object.assign(() => "called", {
      "~standard": anyBody["~standard"],
    }) as unknown as StandardSchemaV1<unknown, unknown>
    const wrapped = bodyParser(callable, { types: [YAML], parse: lines })
    expect(wrapped["~standard"]).toBe(anyBody["~standard"])
    let seen: unknown
    const app = server().post("/in", { body: wrapped }, (c) => {
      seen = c.body
      return { ok: true }
    })
    expect((await app.fetch(post("a: 1\n"))).status).toBe(200)
    expect(seen).toEqual({ a: "1" })
  })
})

describe("bodyParser media type", () => {
  const accepted = [
    YAML,
    "Application/YAML",
    "application/yaml; charset=utf-8",
    "application/yaml;charset=utf-8",
    "application/yaml  ; charset=utf-8",
    "APPLICATION/YAML;x=1",
  ]
  for (const contentType of accepted) {
    test(`reads "${contentType}"`, async () => {
      let seen: unknown
      let told: unknown
      const app = server().post(
        "/in",
        {
          body: bodyParser(anyBody, {
            types: ["Application/Yaml"],
            parse: (bytes, input) => {
              told = input
              return lines(bytes)
            },
          }),
        },
        (c) => {
          seen = c.body
          return { ok: true }
        },
      )
      expect((await app.fetch(post("name: build\n", contentType))).status).toBe(200)
      expect(seen).toEqual({ name: "build" })
      expect(told).toEqual({ mediaType: YAML, contentType })
    })
  }

  const unread: ReadonlyArray<string | null> = [
    null,
    "",
    "text/yaml",
    "application/yamlx",
    "application/yam",
    "xapplication/yaml",
    "application/yaml, application/yaml",
    "application/yaml/extra",
    "text/plain",
    "TEXT/PLAIN",
    "application/octet-stream",
    // A reserved type in a spelling the built-in lanes do not take is not read by the parser either.
    "Application/X-WWW-Form-Urlencoded",
    "multipart/form-data; boundary=x",
  ]
  for (const contentType of unread) {
    test(`answers 415 to ${contentType === null ? "no content-type" : `"${contentType}"`}`, async () => {
      let calls = 0
      const app = appOf(() => {
        calls++
        return {}
      })
      expect(await errorOf(await app.fetch(post("name: build\n", contentType)))).toEqual([
        415,
        { ok: false, error: "unsupported_media_type" },
      ])
      expect(calls).toBe(0)
    })
  }

  test("JSON and urlencoded bodies still reach the schema through their own lanes", async () => {
    let calls = 0
    const seen: unknown[] = []
    const app = appOf(
      () => {
        calls++
        return {}
      },
      undefined,
      (body) => seen.push(body),
    )
    expect((await app.fetch(post('{"a":1}', "application/json"))).status).toBe(200)
    expect((await app.fetch(post("a=1", "application/x-www-form-urlencoded"))).status).toBe(200)
    expect(seen).toEqual([{ a: 1 }, { a: "1" }])
    expect(calls).toBe(0)
  })

  test("a route without a parser still answers 415", async () => {
    const app = server().post("/in", { body: anyBody }, () => ({ ok: true }))
    expect((await app.fetch(post("name: build\n"))).status).toBe(415)
  })
})

describe("bodyParser limits", () => {
  const counting = () => {
    const state = { calls: 0 }
    const app = server().post(
      "/in",
      {
        body: bodyParser(anyBody, {
          types: [YAML],
          parse: (bytes) => {
            state.calls++
            return lines(bytes)
          },
        }),
        bodyLimit: 32,
      },
      () => ({ ok: true }),
    )
    return { app, state }
  }
  const big = `name: ${"x".repeat(64)}\n`

  test("a declared length over the limit is refused before parse", async () => {
    const { app, state } = counting()
    expect(await errorOf(await app.fetch(post(big)))).toEqual([
      413,
      { ok: false, error: "payload_too_large" },
    ])
    expect(state.calls).toBe(0)
  })

  test("a streamed body over the limit is refused before parse", async () => {
    const { app, state } = counting()
    expect(await errorOf(await app.fetch(post(streamOf("name: ", "x".repeat(64), "\n"))))).toEqual([
      413,
      { ok: false, error: "payload_too_large" },
    ])
    expect(state.calls).toBe(0)
  })

  test("a body within the limit is parsed once", async () => {
    const { app, state } = counting()
    expect((await app.fetch(post("name: build\n"))).status).toBe(200)
    expect((await app.fetch(post(streamOf("name: ", "build\n")))).status).toBe(200)
    expect(state.calls).toBe(2)
  })

  test("a content-length that is not a length is refused", async () => {
    const { app, state } = counting()
    const request = post("name: build\n")
    const source = new Proxy(request, {
      get(target, key) {
        if (key === "headers") {
          const headers = new Headers(target.headers)
          headers.set("content-length", "12abc")
          return headers
        }
        const value = Reflect.get(target, key, target) as unknown
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    expect(await errorOf(await app.fetch(source))).toEqual([
      400,
      { ok: false, error: "invalid_content_length" },
    ])
    expect(state.calls).toBe(0)
  })

  test("an empty body reaches parse as zero bytes", async () => {
    let length = -1
    const app = appOf((bytes) => {
      length = bytes.byteLength
      return {}
    })
    expect((await app.fetch(post(""))).status).toBe(200)
    expect(length).toBe(0)
  })
})

describe("bodyParser decoding", () => {
  test("a parse that throws answers 400", async () => {
    const app = appOf(lines)
    expect(await errorOf(await app.fetch(post("no separator")))).toEqual([
      400,
      { ok: false, error: "invalid_body" },
    ])
  })

  test("bytes that are not the text they claim answer 400", async () => {
    const app = appOf(lines)
    expect((await app.fetch(post(new Uint8Array([0x61, 0xff, 0xfe])))).status).toBe(400)
  })

  test("a parse that rejects answers 400, and its message is not echoed", async () => {
    const app = appOf(() => Promise.reject(new Error("secret parser detail")))
    const response = await app.fetch(post("a: 1\n"))
    expect(response.status).toBe(400)
    const text = await response.text()
    expect(text).not.toContain("secret")
    expect(JSON.parse(text)).toEqual({ ok: false, error: "invalid_body" })
  })

  test("an async parse is awaited", async () => {
    let seen: unknown
    const app = appOf(
      async (bytes) => {
        await Promise.resolve()
        return lines(bytes)
      },
      undefined,
      (body) => {
        seen = body
      },
    )
    expect((await app.fetch(post("a: 1\n"))).status).toBe(200)
    expect(seen).toEqual({ a: "1" })
  })

  test("the schema validates what was decoded", async () => {
    const named: StandardSchemaV1<unknown, { name: string }> = {
      "~standard": {
        version: 1,
        vendor: "nifra-test",
        validate: (value) =>
          typeof (value as { name?: unknown }).name === "string"
            ? { value: value as { name: string } }
            : { issues: [{ message: "name is required", path: ["name"] }] },
        types: undefined as unknown as StandardTypes<unknown, { name: string }>,
      },
    }
    const app = server().post(
      "/in",
      { body: bodyParser(named, { types: [YAML], parse: lines }) },
      (c) => ({ name: c.body.name }),
    )
    const good = await app.fetch(post("name: build\n"))
    expect([good.status, await good.json()]).toEqual([200, { name: "build" }])
    expect((await app.fetch(post("other: build\n"))).status).toBe(422)
  })

  const leaves: ReadonlyArray<readonly [string, unknown]> = [
    ["a string", "text"],
    ["a number", 7],
    ["null", null],
    ["undefined", undefined],
    ["a bigint", 7n],
    ["a date", new Date(0)],
    ["bytes", new Uint8Array(4096)],
    ["a map", new Map([["a", { b: 1 }]])],
    ["a set", new Set([{ a: 1 }, { a: 1 }])],
    ["a null-prototype record", Object.assign(Object.create(null), { a: [1, 2, { b: null }] })],
  ]
  for (const [label, value] of leaves) {
    test(`${label} reaches the schema as decoded`, async () => {
      let seen: unknown = "unset"
      const app = appOf(
        () => value,
        undefined,
        (body) => {
          seen = body
        },
      )
      expect((await app.fetch(post("x"))).status).toBe(200)
      expect(seen).toBe(value)
    })
  }

  test("nesting deeper than the call stack is walked", async () => {
    const root: { next?: unknown } = {}
    let tip = root
    for (let i = 0; i < 200_000; i++) {
      const next = {}
      tip.next = next
      tip = next
    }
    const app = appOf(() => root)
    expect((await app.fetch(post("x"))).status).toBe(200)
  })
})

describe("bodyParser tree enforcement", () => {
  const shared = { x: 1 }
  const cycle: Record<string, unknown> = { name: "loop" }
  cycle.self = cycle
  const deep: unknown[] = []
  deep.push([deep])
  // Thirty levels that each hold the level below twice: sixty references, a billion leaves.
  let laugh: unknown = ["lol"]
  for (let i = 0; i < 30; i++) laugh = [laugh, laugh]

  const shapes: ReadonlyArray<readonly [string, unknown]> = [
    ["an object held twice", { a: shared, b: shared }],
    [
      "an array held twice",
      (() => {
        const list = [1]
        return [list, list]
      })(),
    ],
    ["a cycle", cycle],
    ["a cycle through arrays", deep],
    ["an alias expansion", laugh],
    [
      "a map value held twice",
      new Map<string, unknown>([
        ["a", shared],
        ["b", shared],
      ]),
    ],
  ]
  for (const policy of ["reject", "strip", "ignore"] as const) {
    for (const [label, value] of shapes) {
      test(`${label} answers 400 under "${policy}"`, async () => {
        const app = appOf(() => value, { protoPoisoning: policy })
        const started = performance.now()
        expect(await errorOf(await app.fetch(post("x")))).toEqual([
          400,
          { ok: false, error: "invalid_body" },
        ])
        // Refused on the second sighting, not after the expansion.
        expect(performance.now() - started).toBeLessThan(1000)
      })
    }
  }

  test("the same primitive in two places is a tree", async () => {
    const text = "shared"
    const app = appOf(() => ({ a: text, b: text, c: [text, text] }))
    expect((await app.fetch(post("x"))).status).toBe(200)
  })
})

describe("bodyParser prototype poisoning", () => {
  const ownProto = (): unknown => {
    const record: Record<string, unknown> = { safe: 1 }
    Object.defineProperty(record, "__proto__", {
      value: { admin: true },
      enumerable: true,
      writable: true,
      configurable: true,
    })
    return { nested: [record] }
  }
  const viaConstructor = (): unknown => ({
    nested: { constructor: { prototype: { admin: true } }, safe: 1 },
  })
  // What a decoder that assigns keys one at a time turns a `__proto__` key into.
  const replaced = (): unknown => {
    const record: Record<string, unknown> = { safe: 1 }
    Object.setPrototypeOf(record, { admin: true })
    return { nested: record }
  }

  const run = async (build: () => unknown, policy: "reject" | "strip" | "ignore") => {
    let seen: unknown
    const app = appOf(build, { protoPoisoning: policy }, (body) => {
      seen = body
    })
    const response = await app.fetch(post("x"))
    return { status: response.status, seen }
  }

  test("reject refuses each shape", async () => {
    for (const build of [ownProto, viaConstructor, replaced]) {
      expect((await run(build, "reject")).status).toBe(400)
    }
  })

  test("reject is the default", async () => {
    const app = appOf(replaced)
    expect((await app.fetch(post("x"))).status).toBe(400)
  })

  test("strip removes an own __proto__ key", async () => {
    const { status, seen } = await run(ownProto, "strip")
    expect(status).toBe(200)
    const record = (seen as { nested: Record<string, unknown>[] }).nested[0] as Record<
      string,
      unknown
    >
    expect(Object.keys(record)).toEqual(["safe"])
    expect(Object.hasOwn(record, "__proto__")).toBe(false)
  })

  test("strip removes a constructor that carries a prototype", async () => {
    const { status, seen } = await run(viaConstructor, "strip")
    expect(status).toBe(200)
    expect(Object.keys((seen as { nested: object }).nested)).toEqual(["safe"])
  })

  test("strip restores a replaced prototype", async () => {
    const { status, seen } = await run(replaced, "strip")
    expect(status).toBe(200)
    const record = (seen as { nested: Record<string, unknown> }).nested
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype)
    expect(record.admin).toBeUndefined()
    expect(record.safe).toBe(1)
  })

  test("ignore leaves each shape as decoded", async () => {
    for (const build of [ownProto, viaConstructor, replaced]) {
      expect((await run(build, "ignore")).status).toBe(200)
    }
    const { seen } = await run(replaced, "ignore")
    expect((seen as { nested: Record<string, unknown> }).nested.admin).toBe(true)
  })

  test("a poisoned object inside a map or a set is found", async () => {
    expect((await run(() => new Map([["k", ownProto()]]), "reject")).status).toBe(400)
    expect((await run(() => new Set([replaced()]), "reject")).status).toBe(400)
    expect((await run(() => new Map([[replaced(), "v"]]), "reject")).status).toBe(400)
  })

  test("a plain object made in another realm is walked like one made here", async () => {
    const foreign = (): unknown =>
      runInNewContext('({ nested: { ["__proto__"]: { admin: true }, safe: 1 } })')
    expect((await run(foreign, "reject")).status).toBe(400)
    const { status, seen } = await run(foreign, "strip")
    expect(status).toBe(200)
    expect(Object.keys((seen as { nested: object }).nested)).toEqual(["safe"])
    expect((await run(() => runInNewContext("({ a: { b: [1, 2] } })"), "reject")).status).toBe(200)
  })

  test("a constructor key that is ordinary data is kept", async () => {
    const { status, seen } = await run(() => ({ constructor: "Acme Builders" }), "reject")
    expect(status).toBe(200)
    expect(seen).toEqual({ constructor: "Acme Builders" })
  })

  test("Object.prototype is untouched by a refused body", async () => {
    await run(ownProto, "reject")
    await run(replaced, "strip")
    expect(({} as Record<string, unknown>).admin).toBeUndefined()
  })
})

describe("bodyParser composition", () => {
  const form = (): Request => {
    const data = new FormData()
    data.append("title", "report")
    return new Request("http://x/in", { method: "POST", body: data })
  }
  const CSV = "text/csv"
  const csv = (bytes: Uint8Array): unknown => ({ cells: DECODER.decode(bytes).split(",") })

  const orders = {
    "a parser around a form schema": () =>
      bodyParser(multipartBody(anyBody), { types: [YAML], parse: lines }),
    "a form schema around a parser": () =>
      multipartBody(bodyParser(anyBody, { types: [YAML], parse: lines })),
  }
  for (const [label, build] of Object.entries(orders)) {
    test(`${label} reads both`, async () => {
      const seen: unknown[] = []
      const schema = build()
      const app = server().post("/in", { body: schema }, (c) => {
        seen.push(c.body)
        return { ok: true }
      })
      expect((await app.fetch(post("a: 1\n"))).status).toBe(200)
      expect((await app.fetch(form())).status).toBe(200)
      expect((await app.fetch(post("a,b", CSV))).status).toBe(415)
      expect(seen[0]).toEqual({ a: "1" })
      expect({ ...(seen[1] as object) }).toEqual({ title: "report" })
      expect(reflectRoutes(app)[0]?.schema?.body?.mediaTypes).toEqual([YAML])
    })
  }

  test("two parsers each read their own types", async () => {
    const seen: unknown[] = []
    const schema = bodyParser(bodyParser(anyBody, { types: [YAML], parse: lines }), {
      types: [CSV, "application/csv"],
      parse: csv,
    })
    const app = server().post("/in", { body: schema }, (c) => {
      seen.push(c.body)
      return { ok: true }
    })
    expect((await app.fetch(post("a: 1\n"))).status).toBe(200)
    expect((await app.fetch(post("a,b", CSV))).status).toBe(200)
    expect((await app.fetch(post("a,b", "application/csv"))).status).toBe(200)
    expect((await app.fetch(post("a,b", "text/tsv"))).status).toBe(415)
    expect(seen).toEqual([{ a: "1" }, { cells: ["a", "b"] }, { cells: ["a", "b"] }])
    expect(reflectRoutes(app)[0]?.schema?.body?.mediaTypes).toEqual([CSV, "application/csv", YAML])
  })

  test("the outer parser wins a type both name", async () => {
    let seen: unknown
    const schema = bodyParser(bodyParser(anyBody, { types: [YAML], parse: () => "inner" }), {
      types: [YAML],
      parse: () => "outer",
    })
    const app = server().post("/in", { body: schema }, (c) => {
      seen = c.body
      return { ok: true }
    })
    expect((await app.fetch(post("x"))).status).toBe(200)
    expect(seen).toBe("outer")
    expect(reflectRoutes(app)[0]?.schema?.body?.mediaTypes).toEqual([YAML])
  })

  test("a schema without a parser reflects no media types", () => {
    const app = server()
      .post("/plain", { body: anyBody }, () => ({ ok: true }))
      .post("/form", { body: multipartBody(anyBody) }, () => ({ ok: true }))
    for (const route of reflectRoutes(app)) {
      expect(route.schema?.body !== undefined && "mediaTypes" in route.schema.body).toBe(false)
    }
  })

  test("the declared types cannot be changed after the fact", () => {
    const app = server().post(
      "/in",
      { body: bodyParser(anyBody, { types: [YAML], parse: lines }) },
      () => ({ ok: true }),
    )
    const types = reflectRoutes(app)[0]?.schema?.body?.mediaTypes as string[]
    expect(Object.isFrozen(types)).toBe(true)
    expect(() => types.push("text/plain")).toThrow(TypeError)
  })
})

describe("bodyParser on every lane", () => {
  const schema = { body: bodyParser(anyBody, { types: [YAML], parse: lines }), bodyLimit: 64 }
  const handler = (c: { body: unknown }) => ({ body: c.body })
  const big = `name: ${"x".repeat(128)}\n`

  const apps = {
    "body only": () => server().post("/in", schema, handler),
    "with a derive": () =>
      server()
        .derive(() => ({ who: "x" }))
        .post("/in", schema, handler),
    "with an async derive and beforeHandle": () =>
      server()
        .derive(async () => ({ who: "x" }))
        .beforeHandle(() => undefined)
        .post("/in", schema, handler),
    "with beforeHandle and afterHandle": () =>
      server()
        .beforeHandle(() => undefined)
        .afterHandle((result) => result)
        .post("/in", schema, handler),
    "with onRequest and onResponse": () =>
      server()
        .onRequest(() => undefined)
        .onResponse((response) => response)
        .post("/in", schema, handler),
    "with a query schema": () => server().post("/in", { ...schema, query: anyBody }, handler),
  }

  type NodeOutcome =
    | { kind: "response"; response: Response }
    | { kind: "json"; status: number; body: string | null }
    | { kind: "body"; status: number; body: string | Uint8Array }
  const nodeResult = async (outcome: NodeOutcome): Promise<[number, unknown]> => {
    if (outcome.kind === "response") return [outcome.response.status, await outcome.response.json()]
    const text =
      typeof outcome.body === "string" || outcome.body === null
        ? outcome.body
        : new TextDecoder().decode(outcome.body)
    return [outcome.status, JSON.parse(text ?? "null")]
  }

  const expected = { body: { name: "build" } }
  const cases: ReadonlyArray<readonly [() => Request, readonly [number, unknown]]> = [
    [() => post("name: build\n"), [200, expected]],
    [() => post(streamOf("name: ", "build\n")), [200, expected]],
    [() => post(big), [413, { ok: false, error: "payload_too_large" }]],
    [() => post("no separator"), [400, { ok: false, error: "invalid_body" }]],
    [
      () => post("name: build\n", "text/yaml"),
      [415, { ok: false, error: "unsupported_media_type" }],
    ],
  ]

  for (const [label, build] of Object.entries(apps)) {
    test(`${label}: Web`, async () => {
      const app = build()
      for (const [request, outcome] of cases) {
        expect(await errorOf(await app.fetch(request()))).toEqual([...outcome])
      }
    })

    test(`${label}: Node direct`, async () => {
      const app = build().use(nodeDirect())
      for (const [request, outcome] of cases) {
        expect(await nodeResult(await app.resolveNode(request()))).toEqual([...outcome])
      }
    })
  }
})
