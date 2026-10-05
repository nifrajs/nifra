import { describe, expect, test } from "bun:test"
import { server } from "../src/index.ts"
import { nodeDirect } from "../src/node-direct.ts"
import type { StandardSchemaV1, StandardTypes } from "../src/schema/standard.ts"
import { multipartBody } from "../src/server/multipart.ts"

const BOUNDARY = "----nifraTestBoundary7MA4YWxk"
const ENCODER = new TextEncoder()

const anyBody: StandardSchemaV1<unknown, Record<string, unknown>> = {
  "~standard": {
    version: 1,
    vendor: "nifra-test",
    validate: (value) => ({ value: value as Record<string, unknown> }),
    types: undefined as unknown as StandardTypes<unknown, Record<string, unknown>>,
  },
}

interface Part {
  readonly name: string
  readonly value?: string
  readonly filename?: string
  readonly type?: string
}

function encode(parts: readonly Part[], boundary = BOUNDARY): Uint8Array {
  let text = ""
  for (const part of parts) {
    text += `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`
    if (part.filename !== undefined) text += `; filename="${part.filename}"`
    text += "\r\n"
    if (part.type !== undefined) text += `Content-Type: ${part.type}\r\n`
    text += `\r\n${part.value ?? ""}\r\n`
  }
  return ENCODER.encode(`${text}--${boundary}--\r\n`)
}

function upload(
  body: Uint8Array | ReadableStream<Uint8Array>,
  contentType = `multipart/form-data; boundary=${BOUNDARY}`,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://x/upload", {
    method: "POST",
    headers: { "content-type": contentType, ...headers },
    body,
    // A streamed request body needs the half-duplex opt-in.
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit)
}

async function describeValue(value: unknown): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map(describeValue))
  if (value instanceof File) {
    return { file: value.name, size: value.size, text: await value.text() }
  }
  return value
}

async function describeRecord(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const key of Reflect.ownKeys(body)) {
    out[String(key)] = await describeValue(body[key as string])
  }
  return out
}

const echo = (
  limits?: Parameters<typeof multipartBody>[1],
  options?: Parameters<typeof server>[0],
) =>
  server(options).post("/upload", { body: multipartBody(anyBody, limits) }, (c) =>
    describeRecord(c.body),
  )

const errorOf = async (response: Response): Promise<[number, unknown]> => [
  response.status,
  await response.json(),
]

describe("multipartBody", () => {
  test("text and file parts reach the schema as one null-prototype record", async () => {
    let seen: Record<string, unknown> | undefined
    const app = server().post("/upload", { body: multipartBody(anyBody) }, (c) => {
      seen = c.body
      return describeRecord(c.body)
    })
    const response = await app.fetch(
      upload(
        encode([
          { name: "title", value: "Report" },
          { name: "doc", filename: "report.txt", type: "text/plain", value: "hello" },
        ]),
      ),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      title: "Report",
      doc: { file: "report.txt", size: 5, text: "hello" },
    })
    expect(Object.getPrototypeOf(seen)).toBeNull()
    expect(seen?.doc).toBeInstanceOf(File)
  })

  test("a repeated name becomes an array in part order", async () => {
    const response = await echo().fetch(
      upload(
        encode([
          { name: "tag", value: "a" },
          { name: "tag", value: "b" },
          { name: "tag", value: "c" },
          { name: "files", filename: "1.txt", value: "one" },
          { name: "files", filename: "2.txt", value: "two" },
        ]),
      ),
    )
    expect(await response.json()).toEqual({
      tag: ["a", "b", "c"],
      files: [
        { file: "1.txt", size: 3, text: "one" },
        { file: "2.txt", size: 3, text: "two" },
      ],
    })
  })

  test("an empty file input is left out and is not counted", async () => {
    const response = await echo({ maxFiles: 0 }).fetch(
      upload(
        encode([
          { name: "title", value: "x" },
          { name: "avatar", filename: "", type: "application/octet-stream", value: "" },
        ]),
      ),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ title: "x" })
  })

  test("a file with no bytes is left out, named or not", async () => {
    const response = await echo().fetch(
      upload(
        encode([
          { name: "title", value: "x" },
          { name: "doc", filename: "empty.txt", type: "text/plain", value: "" },
        ]),
      ),
    )
    expect(await response.json()).toEqual({ title: "x" })
  })

  test("the schema it wraps is not changed", () => {
    const branded = multipartBody(anyBody)
    expect(branded).not.toBe(anyBody)
    expect(branded["~standard"]).toBe(anyBody["~standard"])
    expect(Object.getOwnPropertySymbols(anyBody)).toEqual([])
    expect(Object.keys(branded)).toEqual(Object.keys(anyBody))
  })

  test("a callable schema is wrapped without being called", async () => {
    const callable = Object.assign(() => {
      throw new Error("must not be called")
    }, anyBody)
    const app = server().post("/upload", { body: multipartBody(callable) }, (c) =>
      describeRecord(c.body as Record<string, unknown>),
    )
    const response = await app.fetch(upload(encode([{ name: "a", value: "1" }])))
    expect(await response.json()).toEqual({ a: "1" })
  })

  test("opting in a schema that already was replaces its limits", async () => {
    const files = [
      { name: "f", filename: "a.txt", value: "a" },
      { name: "f", filename: "b.txt", value: "b" },
    ]
    const one = multipartBody(anyBody, { maxFiles: 1 })
    const two = multipartBody(one, { maxFiles: 2 })
    const callable = multipartBody(
      multipartBody(Object.assign(() => {}, anyBody) as unknown as typeof anyBody, { maxFiles: 1 }),
      { maxFiles: 2 },
    )
    const count = (schema: typeof anyBody) =>
      server()
        .post("/upload", { body: schema }, (c) => (c.body.f as unknown[]).length)
        .fetch(upload(encode(files)))
    expect(await errorOf(await count(one))).toEqual([413, { ok: false, error: "too_many_files" }])
    expect(await (await count(two)).json()).toBe(2)
    expect(await (await count(callable)).json()).toBe(2)
  })

  test("limits must be non-negative safe integers", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => multipartBody(anyBody, { maxFiles: bad })).toThrow(RangeError)
      expect(() => multipartBody(anyBody, { maxFields: bad })).toThrow(RangeError)
      expect(() => multipartBody(anyBody, { maxFieldBytes: bad })).toThrow(RangeError)
      expect(() => multipartBody(anyBody, { maxFileBytes: bad })).toThrow(RangeError)
    }
  })
})

describe("multipartBody media types", () => {
  test("a route without it still answers 415 to multipart", async () => {
    const app = server().post("/upload", { body: anyBody }, (c) => c.body)
    expect(await errorOf(await app.fetch(upload(encode([{ name: "a", value: "1" }]))))).toEqual([
      415,
      { ok: false, error: "unsupported_media_type" },
    ])
  })

  test("a media type that is not multipart answers 415", async () => {
    for (const contentType of ["text/plain", "multipart/mixed; boundary=x", "", "multipart"]) {
      const response = await echo().fetch(upload(ENCODER.encode("x"), contentType))
      expect(await errorOf(response)).toEqual([415, { ok: false, error: "unsupported_media_type" }])
    }
  })

  test("JSON and urlencoded bodies keep their lanes", async () => {
    const app = echo()
    const json = await app.fetch(
      new Request("http://x/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: 1 }),
      }),
    )
    expect(await json.json()).toEqual({ a: 1 })
    const form = await app.fetch(
      new Request("http://x/upload", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "a=1&a=2",
      }),
    )
    expect(await form.json()).toEqual({ a: ["1", "2"] })
  })
})

describe("multipartBody boundary", () => {
  const body = encode([{ name: "a", value: "1" }])

  test("accepted spellings", async () => {
    for (const contentType of [
      `multipart/form-data; boundary=${BOUNDARY}`,
      `multipart/form-data; boundary="${BOUNDARY}"`,
      `Multipart/Form-Data; BOUNDARY=${BOUNDARY}`,
      `multipart/form-data; charset=utf-8; boundary=${BOUNDARY}`,
      `multipart/form-data;boundary=${BOUNDARY};`,
      `multipart/form-data ;\tboundary=${BOUNDARY} ; charset="utf-8"`,
    ]) {
      const response = await echo().fetch(upload(body, contentType))
      expect([contentType, response.status]).toEqual([contentType, 200])
      expect(await response.json()).toEqual({ a: "1" })
    }
  })

  test("a boundary of special characters is parsed quoted or bare", async () => {
    const special = "a'()+_,-./:=?z"
    const parts = encode([{ name: "a", value: "1" }], special)
    for (const contentType of [
      `multipart/form-data; boundary="${special}"`,
      `multipart/form-data; boundary=${special}`,
    ]) {
      const response = await echo().fetch(upload(parts, contentType))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ a: "1" })
    }
  })

  test("malformed, missing, repeated, and oversized boundaries answer 400", async () => {
    for (const contentType of [
      "multipart/form-data",
      "multipart/form-data;",
      "multipart/form-data; charset=utf-8",
      "multipart/form-data; boundary=",
      'multipart/form-data; boundary=""',
      `multipart/form-data; boundary="${BOUNDARY}`,
      `multipart/form-data; boundary="${BOUNDARY}"x`,
      `multipart/form-data; boundary=${BOUNDARY}; boundary=${BOUNDARY}`,
      `multipart/form-data; boundary=${BOUNDARY}; BOUNDARY=other`,
      `multipart/form-data; boundary=${"a".repeat(71)}`,
      "multipart/form-data; boundary=has space",
      'multipart/form-data; boundary="a\\"b"',
      "multipart/form-data; boundary=a\u00e9b",
      `multipart/form-data; boundary=${BOUNDARY}, multipart/form-data; boundary=other`,
      `multipart/form-data; =x; boundary=${BOUNDARY}`,
      `multipart/form-data; novalue; boundary=${BOUNDARY}extra`,
    ]) {
      const response = await echo().fetch(upload(body, contentType))
      expect([contentType, ...(await errorOf(response))]).toEqual([
        contentType,
        400,
        { ok: false, error: "invalid_multipart" },
      ])
    }
  })

  test("a boundary inside another parameter's quoted value is not the boundary", async () => {
    // The part count and the parse both use the one boundary this reader extracted.
    const hidden = encode([{ name: "evil", value: "1" }], "evil")
    const real = encode([{ name: "real", value: hidden.length.toString() }])
    const contentType = `multipart/form-data; note="x; boundary=evil"; boundary=${BOUNDARY}`
    const response = await echo().fetch(upload(real, contentType))
    expect(await response.json()).toEqual({ real: String(hidden.length) })
    const swapped = await echo().fetch(upload(hidden, contentType))
    expect(await errorOf(swapped)).toEqual([400, { ok: false, error: "invalid_multipart" }])
  })
})

describe("multipartBody size and count bounds", () => {
  test("a declared length over the route cap is refused before the body is read", async () => {
    const app = server().post("/upload", { body: multipartBody(anyBody), bodyLimit: 64 }, (c) =>
      describeRecord(c.body),
    )
    const body = encode([{ name: "a", value: "x".repeat(200) }])
    const response = await app.fetch(
      upload(body, undefined, { "content-length": String(body.length) }),
    )
    expect(await errorOf(response)).toEqual([413, { ok: false, error: "payload_too_large" }])
  })

  test("a body that delivers more than it declared is refused", async () => {
    const app = server().post("/upload", { body: multipartBody(anyBody), bodyLimit: 10_000 }, (c) =>
      describeRecord(c.body),
    )
    const body = encode([{ name: "a", value: "x".repeat(200) }])
    const response = await app.fetch(upload(body, undefined, { "content-length": "10" }))
    expect(await errorOf(response)).toEqual([413, { ok: false, error: "payload_too_large" }])
  })

  test("a malformed Content-Length is refused", async () => {
    const response = await echo().fetch(
      upload(encode([{ name: "a", value: "1" }]), undefined, { "content-length": "12abc" }),
    )
    expect(await errorOf(response)).toEqual([400, { ok: false, error: "invalid_content_length" }])
  })

  test("a streamed body over the cap is refused", async () => {
    const app = server().post("/upload", { body: multipartBody(anyBody), bodyLimit: 64 }, (c) =>
      describeRecord(c.body),
    )
    const body = encode([{ name: "a", value: "x".repeat(500) }])
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body.subarray(0, 100))
        controller.enqueue(body.subarray(100))
        controller.close()
      },
    })
    expect(await errorOf(await app.fetch(upload(stream)))).toEqual([
      413,
      { ok: false, error: "payload_too_large" },
    ])
  })

  test("a streamed body within the cap is parsed", async () => {
    const body = encode([{ name: "a", value: "1" }])
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body.subarray(0, 7))
        controller.enqueue(body.subarray(7))
        controller.close()
      },
    })
    expect(await (await echo().fetch(upload(stream))).json()).toEqual({ a: "1" })
  })

  test("a flood of parts is refused before it is parsed", async () => {
    const parts: Part[] = []
    for (let i = 0; i < 112; i++) parts.push({ name: `f${i}`, value: "" })
    const response = await echo().fetch(upload(encode(parts)))
    expect(await errorOf(response)).toEqual([413, { ok: false, error: "too_many_parts" }])
  })

  test("exactly maxFields + maxFiles parts is allowed", async () => {
    const response = await echo({ maxFields: 2, maxFiles: 1 }).fetch(
      upload(
        encode([
          { name: "a", value: "1" },
          { name: "b", value: "2" },
          { name: "c", filename: "c.txt", value: "3" },
        ]),
      ),
    )
    expect(response.status).toBe(200)
    const over = await echo({ maxFields: 2, maxFiles: 1 }).fetch(
      upload(
        encode([
          { name: "a", value: "1" },
          { name: "b", value: "2" },
          { name: "c", filename: "c.txt", value: "3" },
          { name: "d", value: "4" },
        ]),
      ),
    )
    expect(await errorOf(over)).toEqual([413, { ok: false, error: "too_many_parts" }])
  })

  test("the boundary text inside a part counts toward the part bound", async () => {
    // A delimiter is counted wherever it sits, so file content cannot hide parts from the count.
    const response = await echo({ maxFields: 1, maxFiles: 1 }).fetch(
      upload(encode([{ name: "doc", filename: "a.txt", value: `x--${BOUNDARY}y--${BOUNDARY}z` }])),
    )
    expect(await errorOf(response)).toEqual([413, { ok: false, error: "too_many_parts" }])
  })

  test("too many text parts, within the part bound", async () => {
    const response = await echo({ maxFields: 1 }).fetch(
      upload(
        encode([
          { name: "a", value: "1" },
          { name: "b", value: "2" },
        ]),
      ),
    )
    expect(await errorOf(response)).toEqual([413, { ok: false, error: "too_many_fields" }])
  })

  test("too many files, within the part bound", async () => {
    const response = await echo({ maxFiles: 1 }).fetch(
      upload(
        encode([
          { name: "a", filename: "a.txt", value: "1" },
          { name: "a", filename: "b.txt", value: "2" },
        ]),
      ),
    )
    expect(await errorOf(response)).toEqual([413, { ok: false, error: "too_many_files" }])
  })

  test("a text value is measured in UTF-8 bytes", async () => {
    const app = echo({ maxFieldBytes: 10 })
    expect((await app.fetch(upload(encode([{ name: "a", value: "0123456789" }])))).status).toBe(200)
    expect(
      await errorOf(await app.fetch(upload(encode([{ name: "a", value: "0123456789a" }])))),
    ).toEqual([413, { ok: false, error: "field_too_large" }])
    // Five two-byte characters fit; six do not, though both are under ten code units.
    expect((await app.fetch(upload(encode([{ name: "a", value: "ééééé" }])))).status).toBe(200)
    expect(
      await errorOf(await app.fetch(upload(encode([{ name: "a", value: "éééééé" }])))),
    ).toEqual([413, { ok: false, error: "field_too_large" }])
    // Two four-byte characters and two one-byte ones are exactly ten.
    expect((await app.fetch(upload(encode([{ name: "a", value: "😀😀ab" }])))).status).toBe(200)
    expect(
      await errorOf(await app.fetch(upload(encode([{ name: "a", value: "😀😀abc" }])))),
    ).toEqual([413, { ok: false, error: "field_too_large" }])
  })

  test("a file over maxFileBytes is refused", async () => {
    const app = echo({ maxFileBytes: 4 })
    expect(
      (await app.fetch(upload(encode([{ name: "a", filename: "a.txt", value: "1234" }])))).status,
    ).toBe(200)
    expect(
      await errorOf(
        await app.fetch(upload(encode([{ name: "a", filename: "a.txt", value: "12345" }]))),
      ),
    ).toEqual([413, { ok: false, error: "file_too_large" }])
  })

  test("a body of dashes against a boundary of dashes is scanned in linear time", async () => {
    const boundary = `${"-".repeat(69)}x`
    const app = server().post(
      "/upload",
      { body: multipartBody(anyBody), bodyLimit: 4_000_000 },
      (c) => describeRecord(c.body),
    )
    const started = performance.now()
    const response = await app.fetch(
      upload(new Uint8Array(2_000_000).fill(45), `multipart/form-data; boundary=${boundary}`),
    )
    expect(await errorOf(response)).toEqual([400, { ok: false, error: "invalid_multipart" }])
    // A quadratic scan reads this body about seventy times over; the bound is far above one pass.
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  test("a self-overlapping boundary is counted past the linear fallback", async () => {
    // Enough dashes to spend the scan budget, then more parts than the bound allows.
    const boundary = "-----x"
    const parts: Part[] = [{ name: "pad", filename: "pad.bin", value: "-".repeat(4_000) }]
    for (let i = 0; i < 12; i++) parts.push({ name: `f${i}`, value: "" })
    const app = echo({ maxFields: 5, maxFiles: 1 })
    const response = await app.fetch(
      upload(encode(parts, boundary), `multipart/form-data; boundary=${boundary}`),
    )
    expect(await errorOf(response)).toEqual([413, { ok: false, error: "too_many_parts" }])
  })
})

describe("multipartBody malformed bodies", () => {
  test("an empty body, a missing closing delimiter, and a wrong boundary answer 400", async () => {
    const open = ENCODER.encode(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n`,
    )
    for (const body of [new Uint8Array(0), open, encode([{ name: "a", value: "1" }], "other")]) {
      const response = await echo().fetch(upload(body))
      expect(await errorOf(response)).toEqual([400, { ok: false, error: "invalid_multipart" }])
    }
  })

  test("a closed body whose part has no header block answers 400", async () => {
    for (const head of ['Content-Disposition: form-data; name="a"', "not a header\r\n"]) {
      const body = ENCODER.encode(`--${BOUNDARY}\r\n${head}\r\n--${BOUNDARY}--\r\n`)
      const response = await echo().fetch(upload(body))
      expect(await errorOf(response)).toEqual([400, { ok: false, error: "invalid_multipart" }])
    }
  })
})

describe("multipartBody closing delimiter", () => {
  const part = (name: string, value: string, boundary = BOUNDARY): string =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`

  test("a body that stops before it is refused, wherever it stops", async () => {
    const whole = part("a", "1") + part("b", "2")
    for (const body of [
      whole,
      `${whole}--${BOUNDARY}`,
      `${whole}--${BOUNDARY}\r\n`,
      `${whole}--${BOUNDARY}-`,
      `${part("a", "1")}--${BOUNDARY}\r\nContent-Disposition: form-data; name="b"\r\n\r\n2`,
    ]) {
      const response = await echo().fetch(upload(ENCODER.encode(body)))
      expect(await errorOf(response)).toEqual([400, { ok: false, error: "invalid_multipart" }])
    }
  })

  test("the line break after it is optional", async () => {
    for (const tail of ["", "\r\n"]) {
      const body = ENCODER.encode(`${part("a", "1")}--${BOUNDARY}--${tail}`)
      const response = await echo().fetch(upload(body))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ a: "1" })
    }
  })

  test("it is found past the linear fallback", async () => {
    // Enough dashes to spend the scan budget before the delimiter that closes the body.
    const boundary = "-----x"
    const open = `${part("pad", "-".repeat(4_000), boundary)}${part("a", "1", boundary)}`
    const type = `multipart/form-data; boundary=${boundary}`
    const closed = await echo().fetch(upload(ENCODER.encode(`${open}--${boundary}--\r\n`), type))
    expect(closed.status).toBe(200)
    expect(await closed.json()).toMatchObject({ a: "1" })
    const cut = await echo().fetch(upload(ENCODER.encode(open), type))
    expect(await errorOf(cut)).toEqual([400, { ok: false, error: "invalid_multipart" }])
  })
})

describe("multipartBody prototype poisoning", () => {
  const body = encode([
    { name: "__proto__", value: "polluted" },
    { name: "a", value: "1" },
  ])

  test("reject is the default", async () => {
    expect(await errorOf(await echo().fetch(upload(body)))).toEqual([
      400,
      { ok: false, error: "invalid_multipart" },
    ])
  })

  test("strip drops the part", async () => {
    const response = await echo(undefined, { protoPoisoning: "strip" }).fetch(upload(body))
    expect(await response.json()).toEqual({ a: "1" })
  })

  test("ignore keeps it as an own key of a null-prototype record", async () => {
    let seen: Record<string, unknown> | undefined
    const app = server({ protoPoisoning: "ignore" }).post(
      "/upload",
      { body: multipartBody(anyBody) },
      (c) => {
        seen = c.body
        return { ok: true }
      },
    )
    expect((await app.fetch(upload(body))).status).toBe(200)
    expect(Object.getPrototypeOf(seen)).toBeNull()
    expect(Object.hasOwn(seen as object, "__proto__")).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test("a file part named __proto__ follows the same policy", async () => {
    const file = encode([{ name: "__proto__", filename: "a.txt", value: "x" }])
    expect((await echo().fetch(upload(file))).status).toBe(400)
  })
})

describe("multipartBody file names", () => {
  const nameOf = async (filename: string): Promise<unknown> => {
    const response = await echo().fetch(
      upload(encode([{ name: "doc", filename, type: "text/plain", value: "x" }])),
    )
    expect(response.status).toBe(200)
    return ((await response.json()) as { doc: { file: string } }).doc.file
  }

  test("a directory is removed, whichever separator spells it", async () => {
    expect(await nameOf("../../etc/passwd")).toBe("passwd")
    expect(await nameOf("C:\\\\Users\\\\x\\\\evil.exe")).toBe("evil.exe")
    expect(await nameOf("a/b\\\\c/report.pdf")).toBe("report.pdf")
    expect(await nameOf("/abs/name.txt")).toBe("name.txt")
  })

  test("a name with nothing left is replaced", async () => {
    expect(await nameOf("..")).toBe("file")
    expect(await nameOf(".")).toBe("file")
    expect(await nameOf("dir/")).toBe("file")
    expect(await nameOf("a/..")).toBe("file")
    expect(await nameOf("\u202e\u200f")).toBe("file")
    expect(await nameOf("   ")).toBe("file")
  })

  test("control and bidirectional characters are removed", async () => {
    expect(await nameOf("invoice\u202egpj.exe")).toBe("invoicegpj.exe")
    expect(await nameOf("a\u0001b\u007fc\u2066d\u2069e.txt")).toBe("abcde.txt")
    expect(await nameOf("line\u2028break\u2029.txt")).toBe("linebreak.txt")
  })

  test("an ordinary name is unchanged", async () => {
    expect(await nameOf("Résumé (final) v2.pdf")).toBe("Résumé (final) v2.pdf")
    expect(await nameOf(".env")).toBe(".env")
    expect(await nameOf("...")).toBe("...")
  })

  test("a long name is cut to 255 code units without splitting a character", async () => {
    expect(await nameOf("a".repeat(400))).toBe("a".repeat(255))
    const cut = (await nameOf(`${"a".repeat(254)}😀tail`)) as string
    expect(cut).toBe("a".repeat(254))
  })

  test("a renamed file keeps its bytes and is still a File", async () => {
    let seen: unknown
    const app = server().post("/upload", { body: multipartBody(anyBody) }, async (c) => {
      seen = c.body.doc
      return { text: await (c.body.doc as File).text() }
    })
    const response = await app.fetch(
      upload(encode([{ name: "doc", filename: "../x.txt", type: "text/plain", value: "payload" }])),
    )
    expect(await response.json()).toEqual({ text: "payload" })
    expect(seen).toBeInstanceOf(File)
    expect((seen as File).name).toBe("x.txt")
    expect((seen as File).size).toBe(7)
  })
})

describe("multipartBody on every body lane", () => {
  const body = (): Uint8Array =>
    encode([
      { name: "title", value: "t" },
      { name: "doc", filename: "../d.txt", value: "data" },
    ])
  const expected = { title: "t", doc: { file: "d.txt", size: 4, text: "data" } }
  const handler = (c: { body: Record<string, unknown> }) => describeRecord(c.body)
  const schema = { body: multipartBody(anyBody, { maxFields: 1, maxFiles: 1 }) }
  const flood = (): Uint8Array =>
    encode([
      { name: "a", value: "1" },
      { name: "b", value: "2" },
      { name: "c", value: "3" },
    ])

  const apps = {
    "body only": () => server().post("/upload", schema, handler),
    "with a derive": () =>
      server()
        .derive(() => ({ who: "x" }))
        .post("/upload", schema, handler),
    "with an async derive and beforeHandle": () =>
      server()
        .derive(async () => ({ who: "x" }))
        .beforeHandle(() => undefined)
        .post("/upload", schema, handler),
    "with beforeHandle and afterHandle": () =>
      server()
        .beforeHandle(() => undefined)
        .afterHandle((result) => result)
        .post("/upload", schema, handler),
    "with onRequest and onResponse": () =>
      server()
        .onRequest(() => undefined)
        .onResponse((response) => response)
        .post("/upload", schema, handler),
    "with a query schema": () => server().post("/upload", { ...schema, query: anyBody }, handler),
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

  for (const [label, build] of Object.entries(apps)) {
    test(`${label}: Web`, async () => {
      const app = build()
      const response = await app.fetch(upload(body()))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(expected)
      expect(await errorOf(await app.fetch(upload(flood())))).toEqual([
        413,
        { ok: false, error: "too_many_parts" },
      ])
    })

    test(`${label}: Node direct`, async () => {
      const app = build().use(nodeDirect())
      expect(await nodeResult(await app.resolveNode(upload(body())))).toEqual([200, expected])
      expect(await nodeResult(await app.resolveNode(upload(flood())))).toEqual([
        413,
        { ok: false, error: "too_many_parts" },
      ])
    })
  }
})
