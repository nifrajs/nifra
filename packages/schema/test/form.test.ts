import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import { multipartBody } from "@nifrajs/core/multipart"
import { validateStandard } from "@nifrajs/core/schema"
import { t } from "../src/form.ts"
import { t as plainT, toOpenAPI } from "../src/index.ts"

/**
 * Runtime contract for `t.file` and `t.form`: what a file field accepts, that `accept` is decided
 * by the file's bytes and never by what the client claimed, and that a form validates the way a
 * multipart body actually arrives (every text value a string, a repeated name a list).
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3])
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0])
const HTML = new TextEncoder().encode("<script>alert(1)</script>")

const fileOf = (bytes: Uint8Array, name: string, type: string): File =>
  new File([bytes as BlobPart], name, { type })

const issuesOf = async (schema: Parameters<typeof validateStandard>[0], value: unknown) => {
  const outcome = await validateStandard(schema, value)
  if (outcome.ok) throw new Error("expected validation to fail")
  return outcome.issues.map((issue) => ({ path: issue.path, message: issue.message }))
}

const parsed = async <T>(schema: Parameters<typeof validateStandard>[0], value: unknown) => {
  const outcome = await validateStandard(schema, value)
  if (!outcome.ok) throw new Error(`expected success, got ${JSON.stringify(outcome.issues)}`)
  return outcome.value as T
}

describe("t.file", () => {
  test("accepts a File and returns the same instance, synchronously", () => {
    const file = fileOf(HTML, "a.txt", "text/plain")
    const result = t.file()["~standard"].validate(file)
    expect(result).not.toBeInstanceOf(Promise)
    expect((result as { value: File }).value).toBe(file)
  })

  test("rejects everything that is not a File", async () => {
    for (const value of ["a.png", 1, null, undefined, {}, [], new Blob(["x"])]) {
      expect(await issuesOf(t.file(), value)).toEqual([
        { path: undefined, message: "Expected a file" },
      ])
    }
    // A repeated name arrives as a list: a single-file field does not pick one of them.
    expect(await issuesOf(t.file(), [fileOf(PNG, "a.png", "image/png")])).toEqual([
      { path: undefined, message: "Expected a file" },
    ])
  })

  test("maxBytes bounds the size, inclusive", async () => {
    const schema = t.file({ maxBytes: PNG.length })
    expect((await parsed<File>(schema, fileOf(PNG, "a.png", "image/png"))).size).toBe(PNG.length)
    expect(
      await issuesOf(t.file({ maxBytes: PNG.length - 1 }), fileOf(PNG, "a.png", "image/png")),
    ).toEqual([{ path: undefined, message: `File is larger than ${PNG.length - 1} bytes` }])
  })

  test("maxBytes must be a non-negative safe integer", () => {
    for (const maxBytes of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => t.file({ maxBytes })).toThrow(RangeError)
    }
    expect(() => t.file({ maxBytes: 0 })).not.toThrow()
  })

  test("accept is decided by the bytes, not by the claimed type or the name", async () => {
    const schema = t.file({ accept: ["image/png"] })
    // A script dressed up as a PNG: right name, right claimed type, wrong bytes.
    expect(await issuesOf(schema, fileOf(HTML, "photo.png", "image/png"))).toEqual([
      { path: undefined, message: "File type could not be recognized" },
    ])
    // A real GIF claiming to be a PNG.
    expect(await issuesOf(schema, fileOf(GIF, "photo.png", "image/png"))).toEqual([
      { path: undefined, message: "File type image/gif is not accepted" },
    ])
    // A real PNG mislabelled by the client is accepted - and relabelled.
    const accepted = await parsed<File>(schema, fileOf(PNG, "photo.bin", "text/html"))
    expect(accepted).toBeInstanceOf(File)
    expect(accepted.type).toBe("image/png")
    expect(accepted.name).toBe("photo.bin")
    expect(new Uint8Array(await accepted.arrayBuffer())).toEqual(PNG)
  })

  test("a file whose type already matches its bytes is returned as is", async () => {
    const file = fileOf(PNG, "a.png", "image/png")
    expect(await parsed<File>(t.file({ accept: ["image/*"] }), file)).toBe(file)
  })

  test("a wildcard covers the subtypes the bytes can prove", async () => {
    const schema = t.file({ accept: ["image/*"] })
    expect((await parsed<File>(schema, fileOf(GIF, "a", ""))).type).toBe("image/gif")
    const pdf = new TextEncoder().encode("%PDF-1.7 ....")
    expect(await issuesOf(schema, fileOf(pdf, "a.png", "image/png"))).toEqual([
      { path: undefined, message: "File type application/pdf is not accepted" },
    ])
  })

  test("an empty or too-short file never passes accept", async () => {
    const schema = t.file({ accept: ["image/png"] })
    expect(await issuesOf(schema, fileOf(new Uint8Array(0), "a.png", "image/png"))).toHaveLength(1)
    expect(await issuesOf(schema, fileOf(PNG.subarray(0, 7), "a.png", "image/png"))).toHaveLength(1)
  })

  test("the size bound is checked before any byte is read", () => {
    const schema = t.file({ maxBytes: 4, accept: ["image/png"] })
    // Synchronous result: the oversized file was rejected without the asynchronous read.
    const result = schema["~standard"].validate(fileOf(PNG, "a.png", "image/png"))
    expect(result).not.toBeInstanceOf(Promise)
  })

  test("accept refuses a type the bytes cannot prove", () => {
    for (const pattern of [
      "text/csv",
      "image/svg+xml",
      "text/*",
      "*/*",
      "*",
      "",
      "image",
      "image/",
      "IMAGE/PNG",
      "image/png ",
      "application/*+zip",
    ]) {
      expect(() => t.file({ accept: [pattern] })).toThrow(TypeError)
    }
    expect(() => t.file({ accept: [] })).toThrow(TypeError)
    expect(() => t.file({ accept: ["image/png", "text/plain"] })).toThrow(TypeError)
    expect(() => t.file({ accept: "image/png" as unknown as string[] })).toThrow(TypeError)
    expect(() => t.file({ accept: [1 as unknown as string] })).toThrow(TypeError)
    expect(() => t.file({ accept: ["image/png", "video/*", "application/pdf"] })).not.toThrow()
  })

  test("a later change to the caller's accept list does not widen the schema", async () => {
    const accept = ["image/png"]
    const schema = t.file({ accept })
    accept.push("image/gif")
    expect(await issuesOf(schema, fileOf(GIF, "a.gif", "image/gif"))).toHaveLength(1)
  })

  test("its JSON Schema is a binary string", () => {
    expect(JSON.parse(JSON.stringify(t.file({ maxBytes: 10 }).jsonSchema))).toEqual({
      type: "string",
      format: "binary",
    })
  })
})

describe("t.optional / t.array over files", () => {
  test("an optional file may be absent, and is still checked when present", async () => {
    const schema = t.optional(t.file({ accept: ["image/png"] }))
    expect((await validateStandard(schema, undefined)) as unknown).toEqual({
      ok: true,
      value: undefined,
    })
    expect((await parsed<File>(schema, fileOf(PNG, "a", ""))).type).toBe("image/png")
    expect(await issuesOf(schema, "")).toEqual([{ path: undefined, message: "Expected a file" }])
    expect(await issuesOf(schema, null)).toEqual([{ path: undefined, message: "Expected a file" }])
    expect(await issuesOf(schema, fileOf(HTML, "a.png", "image/png"))).toHaveLength(1)
  })

  test("a list validates every file and reports the failing position", async () => {
    const schema = t.array(t.file({ accept: ["image/png"] }))
    const good = fileOf(PNG, "a.png", "image/png")
    expect(await parsed<File[]>(schema, [good, good])).toEqual([good, good])
    expect(await parsed<File[]>(schema, [])).toEqual([])
    expect(await issuesOf(schema, [good, fileOf(HTML, "b.png", "image/png"), "x"])).toEqual([
      { path: [1], message: "File type could not be recognized" },
      { path: [2], message: "Expected a file" },
    ])
    expect(await issuesOf(schema, good)).toEqual([
      { path: undefined, message: "Expected a list of files" },
    ])
  })

  test("minItems and maxItems bound the list", async () => {
    const schema = t.array(t.file(), { minItems: 1, maxItems: 2 })
    const file = fileOf(PNG, "a.png", "image/png")
    expect(await issuesOf(schema, [])).toEqual([
      { path: undefined, message: "Expected at least 1 file(s)" },
    ])
    expect(await issuesOf(schema, [file, file, file])).toEqual([
      { path: undefined, message: "Expected at most 2 file(s)" },
    ])
    expect(await parsed<File[]>(schema, [file, file])).toHaveLength(2)
  })

  test("list options that cannot be honored are refused, not ignored", () => {
    expect(() => t.array(t.file(), { uniqueItems: true })).toThrow(TypeError)
    expect(() => t.array(t.file(), { contains: t.string().jsonSchema })).toThrow(TypeError)
    expect(() => t.array(t.file(), { minItems: -1 })).toThrow(RangeError)
    expect(() => t.array(t.file(), { maxItems: 1.5 })).toThrow(RangeError)
    expect(() => t.array(t.array(t.file()))).toThrow(TypeError)
  })

  test("a list without bytes to read validates synchronously", () => {
    const result = t.array(t.file())["~standard"].validate([fileOf(PNG, "a", "")])
    expect(result).not.toBeInstanceOf(Promise)
  })
})

describe("a file field outside t.form", () => {
  const cases: ReadonlyArray<readonly [string, () => unknown]> = [
    ["t.object", () => t.object({ avatar: t.file() })],
    ["t.object with an optional file", () => t.object({ avatar: t.optional(t.file()) })],
    ["t.object with a list of files", () => t.object({ photos: t.array(t.file()) })],
    ["t.looseObject", () => t.looseObject({ avatar: t.file() })],
    ["t.query", () => t.query({ avatar: t.file() })],
    ["t.union", () => t.union([t.string(), t.file()])],
    ["t.record", () => t.record(t.file())],
    ["t.paginated", () => t.paginated(t.file())],
  ]
  for (const [name, build] of cases) {
    test(`${name} refuses it at construction`, () => {
      expect(build).toThrow(/belongs in t\.form\(\) from "@nifrajs\/schema\/form"/)
    })
  }

  test("the constructors are unchanged for everything else", async () => {
    const schema = t.object({ tags: t.array(t.string()), nick: t.optional(t.string()) })
    expect(await validateStandard(schema, { tags: ["a"] })).toEqual({
      ok: true,
      value: { tags: ["a"] },
    })
  })
})

describe("t.form", () => {
  const avatar = fileOf(PNG, "me.png", "image/png")

  test("coerces text fields and keeps files", async () => {
    const schema = t.form({
      title: t.string(),
      age: t.integer({ minimum: 0 }),
      score: t.number(),
      subscribed: t.boolean(),
      avatar: t.file(),
    })
    const value = await parsed<Record<string, unknown>>(schema, {
      title: "hi",
      age: "42",
      score: "1.5",
      subscribed: "true",
      avatar,
    })
    expect(Object.getPrototypeOf(value)).toBeNull()
    expect({ ...value }).toEqual({ title: "hi", age: 42, score: 1.5, subscribed: true, avatar })
  })

  test("a value that does not coerce is rejected at its field", async () => {
    const schema = t.form({ age: t.integer(), avatar: t.file() })
    const issues = await issuesOf(schema, { age: "abc", avatar })
    expect(issues.map((issue) => issue.path)).toEqual([["age"]])
  })

  test("does not write into the record it was given", async () => {
    const schema = t.form({ age: t.integer(), avatar: t.file() })
    const input = { age: "42", avatar }
    await parsed(schema, input)
    expect(input).toEqual({ age: "42", avatar })
  })

  test("rejects an undeclared field, text or file", async () => {
    const schema = t.form({ title: t.string() })
    expect(await issuesOf(schema, { title: "a", role: "admin" })).toHaveLength(1)
    expect(await issuesOf(schema, { title: "a", payload: avatar })).toHaveLength(1)
  })

  test("additionalProperties: true lets undeclared fields through untouched", async () => {
    const schema = t.form({ title: t.string() }, { additionalProperties: true })
    const value = await parsed<Record<string, unknown>>(schema, { title: "a", extra: "1" })
    expect({ ...value }).toEqual({ title: "a", extra: "1" })
  })

  test("an explicitly undefined additionalProperties stays closed", async () => {
    const schema = t.form({ title: t.string() }, { additionalProperties: undefined } as unknown as {
      additionalProperties: boolean
    })
    expect(await issuesOf(schema, { title: "a", role: "admin" })).toHaveLength(1)
  })

  test("a required file that was not sent is reported at its field", async () => {
    const schema = t.form({ title: t.string(), avatar: t.file() })
    expect(await issuesOf(schema, { title: "a" })).toEqual([
      { path: ["avatar"], message: "Expected a file" },
    ])
  })

  test("an optional file that was not sent is absent from the output", async () => {
    const schema = t.form({ title: t.string(), avatar: t.optional(t.file()) })
    const value = await parsed<Record<string, unknown>>(schema, { title: "a" })
    expect(Object.keys(value)).toEqual(["title"])
  })

  test("a text value in a file field and a file in a text field are both rejected", async () => {
    const schema = t.form({ title: t.string(), avatar: t.file() })
    expect(await issuesOf(schema, { title: "a", avatar: "me.png" })).toEqual([
      { path: ["avatar"], message: "Expected a file" },
    ])
    const issues = await issuesOf(schema, { title: avatar, avatar })
    expect(issues.map((issue) => issue.path)).toEqual([["title"]])
  })

  test("a repeated name never satisfies a single-value field", async () => {
    const schema = t.form({ role: t.string(), avatar: t.file() })
    expect(
      (await issuesOf(schema, { role: ["user", "admin"], avatar })).map((i) => i.path),
    ).toEqual([["role"]])
    expect(await issuesOf(schema, { role: "user", avatar: [avatar, avatar] })).toEqual([
      { path: ["avatar"], message: "Expected a file" },
    ])
  })

  test("a name sent once satisfies a list field; a list nobody filled in is empty", async () => {
    const schema = t.form({
      tags: t.array(t.string()),
      photos: t.array(t.file()),
      notes: t.optional(t.array(t.string())),
      extras: t.optional(t.array(t.file())),
    })
    const one = await parsed<Record<string, unknown>>(schema, { tags: "a", photos: avatar })
    expect({ ...one }).toEqual({ tags: ["a"], photos: [avatar] })
    const many = await parsed<Record<string, unknown>>(schema, {
      tags: ["a", "b"],
      photos: [avatar, avatar],
      notes: "n",
      extras: avatar,
    })
    expect({ ...many }).toEqual({
      tags: ["a", "b"],
      photos: [avatar, avatar],
      notes: ["n"],
      extras: [avatar],
    })
    const none = await parsed<Record<string, unknown>>(schema, {})
    expect({ ...none }).toEqual({ tags: [], photos: [] })
  })

  test("minItems still demands a file when none was sent", async () => {
    const schema = t.form({ photos: t.array(t.file(), { minItems: 1 }) })
    expect(await issuesOf(schema, {})).toEqual([
      { path: ["photos"], message: "Expected at least 1 file(s)" },
    ])
  })

  test("a failing file in a list is reported by field and position", async () => {
    const schema = t.form({ photos: t.array(t.file({ accept: ["image/png"] })) })
    expect(
      await issuesOf(schema, { photos: [avatar, fileOf(HTML, "x.png", "image/png")] }),
    ).toEqual([{ path: ["photos", 1], message: "File type could not be recognized" }])
  })

  test("issues come back in field order, whichever read finishes first", async () => {
    const schema = t.form({
      a: t.file({ accept: ["image/png"] }),
      b: t.file(),
      c: t.file({ accept: ["image/gif"] }),
      title: t.string(),
    })
    const bad = fileOf(HTML, "x", "image/png")
    const issues = await issuesOf(schema, { a: bad, b: "no", c: bad, title: ["x", "y"] })
    expect(issues.map((issue) => issue.path)).toEqual([["title"], ["a"], ["b"], ["c"]])
  })

  test("is synchronous until a file has bytes to read", () => {
    const plain = t.form({ title: t.string(), avatar: t.file({ maxBytes: 100 }) })
    expect(plain["~standard"].validate({ title: "a", avatar })).not.toBeInstanceOf(Promise)
    const sniffing = t.form({ avatar: t.file({ accept: ["image/png"] }) })
    expect(sniffing["~standard"].validate({ avatar })).toBeInstanceOf(Promise)
  })

  test("fields named like Object.prototype members are ordinary fields", async () => {
    const schema = t.form({
      constructor: t.string(),
      toString: t.optional(t.file()),
      hasOwnProperty: t.optional(t.string()),
    })
    const value = await parsed<Record<string, unknown>>(schema, { constructor: "x" })
    expect(Object.keys(value)).toEqual(["constructor"])
    // Nothing is read through the prototype chain of the record handed in.
    const issues = await issuesOf(schema, {})
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.every((issue) => issue.path?.[0] === "constructor")).toBe(true)
  })

  test("a __proto__ entry in the record is an undeclared field, never a prototype", async () => {
    const schema = t.form({ title: t.string() })
    const record = Object.create(null) as Record<string, unknown>
    record.title = "a"
    Object.defineProperty(record, "__proto__", { value: { admin: true }, enumerable: true })
    expect(await issuesOf(schema, record)).toHaveLength(1)
    const open = t.form({ title: t.string() }, { additionalProperties: true })
    const value = await parsed<Record<string, unknown>>(open, record)
    expect(Object.getPrototypeOf(value)).toBeNull()
    expect((value as { admin?: unknown }).admin).toBeUndefined()
    expect(({} as { admin?: unknown }).admin).toBeUndefined()
  })

  test("__proto__ cannot be declared as a field", () => {
    const props = Object.create(null) as Record<string, ReturnType<typeof t.string>>
    Object.defineProperty(props, "__proto__", { value: t.string(), enumerable: true })
    expect(() => t.form(props)).toThrow(TypeError)
  })

  test("rejects a body that is not a record of fields", async () => {
    const schema = t.form({ title: t.optional(t.string()) })
    for (const value of [null, undefined, "title=a", 1, [], [{ title: "a" }]]) {
      expect(await issuesOf(schema, value)).toEqual([
        { path: undefined, message: "Expected form fields" },
      ])
    }
  })

  test("its JSON Schema lists text and file fields together", () => {
    const schema = t.form(
      {
        title: t.string(),
        avatar: t.file(),
        photos: t.optional(t.array(t.file())),
      },
      { description: "Profile" },
    )
    expect(JSON.parse(JSON.stringify(schema.jsonSchema))).toEqual({
      type: "object",
      description: "Profile",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        avatar: { type: "string", format: "binary" },
        photos: { type: "array", items: { type: "string", format: "binary" } },
      },
      required: ["title", "avatar"],
    })
  })
})

describe("a form route", () => {
  const schema = t.form({
    title: t.string({ minLength: 1 }),
    count: t.integer(),
    avatar: t.file({ maxBytes: 1024, accept: ["image/png"] }),
    photos: t.array(t.file({ accept: ["image/*"] }), { maxItems: 2 }),
  })
  const app = server().post("/profile", { body: schema }, (c) => ({
    title: c.body.title,
    count: c.body.count,
    avatar: { name: c.body.avatar.name, type: c.body.avatar.type, size: c.body.avatar.size },
    photos: c.body.photos.map((photo) => photo.type),
  }))

  const post = async (form: FormData): Promise<Response> =>
    app.fetch(new Request("http://localhost/profile", { method: "POST", body: form }))

  test("validates an upload end to end", async () => {
    const form = new FormData()
    form.set("title", "hello")
    form.set("count", "3")
    // Claimed as HTML with a misleading path: the handler sees the detected type and a bare name.
    form.set("avatar", fileOf(PNG, "../../etc/me.html", "text/html"))
    form.append("photos", fileOf(GIF, "a.gif", "image/gif"))
    const response = await post(form)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      title: "hello",
      count: 3,
      avatar: { name: "me.html", type: "image/png", size: PNG.length },
      photos: ["image/gif"],
    })
  })

  test("a disguised file is a validation failure, not a server error", async () => {
    const form = new FormData()
    form.set("title", "hello")
    form.set("count", "3")
    form.set("avatar", fileOf(HTML, "me.png", "image/png"))
    const response = await post(form)
    expect(response.status).toBe(422)
    expect(JSON.stringify(await response.json())).toContain("File type could not be recognized")
  })

  test("an oversized file, an extra field and too many files each fail validation", async () => {
    const base = (): FormData => {
      const form = new FormData()
      form.set("title", "hello")
      form.set("count", "3")
      form.set("avatar", fileOf(PNG, "me.png", "image/png"))
      return form
    }
    const big = base()
    big.set("avatar", fileOf(new Uint8Array(2048), "me.png", "image/png"))
    expect((await post(big)).status).toBe(422)

    const extra = base()
    extra.set("role", "admin")
    expect((await post(extra)).status).toBe(422)

    const many = base()
    for (let i = 0; i < 3; i++) many.append("photos", fileOf(GIF, `${i}.gif`, "image/gif"))
    expect((await post(many)).status).toBe(422)

    expect((await post(base())).status).toBe(200)
  })

  test("a body that is not a form answers 415 to multipart", async () => {
    const bare = server().post("/profile", { body: t.object({ title: t.string() }) }, () => "ok")
    const form = new FormData()
    form.set("title", "hello")
    const response = await bare.fetch(
      new Request("http://localhost/profile", { method: "POST", body: form }),
    )
    expect(response.status).toBe(415)
  })

  test("the form's limits bound the body before it is validated", async () => {
    const send = async (options: { maxFiles?: number; maxFields?: number }, form: FormData) => {
      const limited = server().post(
        "/photos",
        { body: t.form({ photos: t.array(t.file()) }, options) },
        (c) => c.body.photos.length,
      )
      const response = await limited.fetch(
        new Request("http://localhost/photos", { method: "POST", body: form }),
      )
      return { status: response.status, body: await response.json() }
    }
    const photos = (count: number): FormData => {
      const form = new FormData()
      for (let i = 0; i < count; i++) form.append("photos", fileOf(GIF, `${i}.gif`, "image/gif"))
      return form
    }
    expect(await send({ maxFiles: 2 }, photos(2))).toEqual({ status: 200, body: 2 })
    expect(await send({ maxFiles: 2 }, photos(3))).toEqual({
      status: 413,
      body: { ok: false, error: "too_many_files" },
    })
    const note = photos(1)
    note.set("note", "x")
    // A limit answers before the schema would have rejected the undeclared field with a 422.
    expect(await send({ maxFields: 0 }, note)).toEqual({
      status: 413,
      body: { ok: false, error: "too_many_fields" },
    })
    expect(() => t.form({ photos: t.array(t.file()) }, { maxFiles: -1 })).toThrow(RangeError)
  })

  test("multipartBody() over a form replaces its limits", async () => {
    const rewrapped = server().post(
      "/photos",
      {
        body: multipartBody(t.form({ photos: t.array(t.file()) }, { maxFiles: 1 }), {
          maxFiles: 2,
        }),
      },
      (c) => c.body.photos.length,
    )
    const two = new FormData()
    for (let i = 0; i < 2; i++) two.append("photos", fileOf(GIF, `${i}.gif`, "image/gif"))
    const response = await rewrapped.fetch(
      new Request("http://localhost/photos", { method: "POST", body: two }),
    )
    expect(await response.json()).toBe(2)
  })

  test("a form with no required file also takes a JSON or urlencoded body", async () => {
    const mixed = server().post(
      "/notes",
      { body: t.form({ title: t.string(), count: t.integer(), cover: t.optional(t.file()) }) },
      (c) => ({ title: c.body.title, count: c.body.count }),
    )
    const json = await mixed.fetch(
      new Request("http://localhost/notes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "a", count: 2 }),
      }),
    )
    expect(await json.json()).toEqual({ title: "a", count: 2 })
    const urlencoded = await mixed.fetch(
      new Request("http://localhost/notes", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "title=a&count=2",
      }),
    )
    expect(await urlencoded.json()).toEqual({ title: "a", count: 2 })
  })

  test("OpenAPI describes the body as multipart/form-data", () => {
    const document = toOpenAPI(app)
    const body = document.paths["/profile"]?.post?.requestBody
    expect(Object.keys(body?.content ?? {})).toEqual(["multipart/form-data"])
    const documented = body?.content["multipart/form-data"]?.schema as {
      properties: Record<string, unknown>
    }
    expect(documented.properties.avatar).toEqual({ type: "string", format: "binary" })
    expect(documented.properties.photos).toEqual({
      type: "array",
      maxItems: 2,
      items: { type: "string", format: "binary" },
    })
  })

  test("a body without file fields stays application/json in OpenAPI", () => {
    const plain = server().post("/notes", { body: t.object({ title: t.string() }) }, () => "ok")
    const body = toOpenAPI(plain).paths["/notes"]?.post?.requestBody
    expect(Object.keys(body?.content ?? {})).toEqual(["application/json"])
  })
})

describe("a file input nobody filled in", () => {
  const schema = t.form({
    title: t.string(),
    cover: t.optional(t.file()),
    photos: t.array(t.file()),
    extras: t.optional(t.array(t.file())),
    avatar: t.file(),
  })
  const validate = (value: unknown) => schema["~standard"].validate(value)
  const png = () => new File([PNG as BlobPart], "a.png", { type: "image/png" })

  test("an empty text part in a file field is no file", async () => {
    const avatar = png()
    const result = await validate({ title: "a", cover: "", photos: "", extras: "", avatar })
    expect(result.issues).toBeUndefined()
    const value = (result as { value: Record<string, unknown> }).value
    expect(Object.keys(value).sort()).toEqual(["avatar", "photos", "title"])
    expect(value.photos).toEqual([])
  })

  test("empty text parts among the files of a list are left out", async () => {
    const result = await validate({
      title: "a",
      photos: ["", png(), ""],
      extras: ["", ""],
      avatar: png(),
    })
    expect(result.issues).toBeUndefined()
    const value = (result as { value: Record<string, unknown> }).value
    expect((value.photos as File[]).map((photo) => photo.name)).toEqual(["a.png"])
    expect("extras" in value).toBe(false)
  })

  test("it does not stand in for a required file, and other text is still refused", async () => {
    const missing = await validate({ title: "a", avatar: "" })
    expect(missing.issues).toEqual([{ message: "Expected a file", path: ["avatar"] }])
    const text = await validate({ title: "a", avatar: png(), cover: "x" })
    expect(text.issues).toEqual([{ message: "Expected a file", path: ["cover"] }])
  })
})

describe("the two builders", () => {
  test("the plain t has no file or form constructor, and works on a file schema", async () => {
    expect("file" in plainT).toBe(false)
    expect("form" in plainT).toBe(false)
    // A file schema brings its list and optional versions along, so either `t` builds them.
    const list = plainT.array(t.file({ accept: ["image/png"] }), { maxItems: 1 })
    expect(await parsed<File[]>(list, [fileOf(PNG, "a.png", "image/png")])).toHaveLength(1)
    expect(await issuesOf(list, [fileOf(HTML, "a.png", "image/png")])).toEqual([
      { message: "File type could not be recognized", path: [0] },
    ])
    expect(await parsed(plainT.optional(t.file()), undefined as unknown)).toBeUndefined()
    expect(() => plainT.object({ avatar: t.file() })).toThrow(TypeError)
  })

  test("every constructor of the plain t is on the form t, unchanged", () => {
    for (const key of Object.keys(plainT) as Array<keyof typeof plainT>) {
      expect(t[key]).toBe(plainT[key] as never)
    }
  })

  test("a file JSON Schema that lost its validator is refused, not compiled", () => {
    const stripped = { ...t.file() }
    expect(() => plainT.array(stripped)).toThrow(TypeError)
    expect(() => plainT.optional(stripped)).toThrow(TypeError)
  })
})
