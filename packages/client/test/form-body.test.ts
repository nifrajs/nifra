import { describe, expect, test } from "bun:test"
import { client, inProcessClient } from "@nifrajs/client"
import { server } from "@nifrajs/core"
import { t } from "@nifrajs/schema/form"

/**
 * A body that carries a file cannot be JSON, so the client sends it as `multipart/form-data`. These
 * drive the real client against a real app: what leaves the client has to be what `t.form` accepts
 * on the other side.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3])
const png = (name: string): File => new File([PNG as BlobPart], name, { type: "image/png" })

const app = server()
  .post(
    "/profile",
    {
      body: t.form({
        title: t.string(),
        count: t.integer(),
        public: t.boolean(),
        tags: t.array(t.string()),
        avatar: t.file({ accept: ["image/png"] }),
        photos: t.array(t.file()),
        cover: t.optional(t.file()),
      }),
    },
    (c) => ({
      title: c.body.title,
      count: c.body.count,
      public: c.body.public,
      tags: c.body.tags,
      avatar: `${c.body.avatar.name}:${c.body.avatar.size}`,
      photos: c.body.photos.map((photo) => photo.name),
      cover: c.body.cover === undefined ? null : c.body.cover.name,
    }),
  )
  .post("/notes", { body: t.object({ title: t.string() }) }, (c) => ({ title: c.body.title }))

const sent: Array<{ contentType: string | null; body: unknown }> = []
const api = client<typeof app>("http://form.test", {
  fetch: (url, init) => {
    const request = new Request(url, init)
    sent.push({ contentType: request.headers.get("content-type"), body: init?.body })
    return Promise.resolve(app.fetch(request))
  },
})

describe("a body with a file", () => {
  test("is sent as a form the server validates", async () => {
    sent.length = 0
    const result = await api.profile.post({
      title: "hello",
      count: 3,
      public: true,
      tags: ["a", "b"],
      avatar: png("me.png"),
      photos: [png("1.png"), png("2.png")],
    })
    expect(result.error).toBeNull()
    expect(result.data).toEqual({
      title: "hello",
      count: 3,
      public: true,
      tags: ["a", "b"],
      avatar: `me.png:${PNG.length}`,
      photos: ["1.png", "2.png"],
      cover: null,
    })
    expect(sent[0]?.body).toBeInstanceOf(FormData)
    expect(sent[0]?.contentType).toMatch(/^multipart\/form-data; boundary=/)
  })

  test("an empty list sends no part and arrives as an empty list", async () => {
    const result = await api.profile.post({
      title: "hello",
      count: 0,
      public: false,
      tags: [],
      avatar: png("me.png"),
      photos: [],
    })
    expect(result.data).toMatchObject({ tags: [], photos: [], cover: null, public: false })
  })

  test("a content-type set by the caller does not replace the form's own", async () => {
    sent.length = 0
    const result = await api.profile.post(
      {
        title: "hello",
        count: 1,
        public: true,
        tags: [],
        avatar: png("me.png"),
        photos: [],
      },
      { headers: { "Content-Type": "application/json" } },
    )
    expect(result.error).toBeNull()
    expect(sent[0]?.contentType).toMatch(/^multipart\/form-data; boundary=/)
  })

  test("a FormData body is sent as is", async () => {
    const form = new FormData()
    form.set("title", "raw")
    form.set("count", "2")
    form.set("public", "false")
    form.set("avatar", png("raw.png"))
    const loose = api as unknown as {
      profile: { post: (body: FormData) => Promise<{ data: unknown; error: unknown }> }
    }
    const result = await loose.profile.post(form)
    expect(result.error).toBeNull()
    expect(result.data).toMatchObject({ title: "raw", count: 2, avatar: `raw.png:${PNG.length}` })
  })

  test("an absent or null value sends no part", async () => {
    const loose = api as unknown as {
      profile: { post: (body: Record<string, unknown>) => Promise<{ data: unknown }> }
    }
    const result = await loose.profile.post({
      title: "hello",
      count: 1,
      public: true,
      avatar: png("me.png"),
      cover: undefined,
      tags: null,
    })
    expect(result.data).toMatchObject({ cover: null, tags: [], photos: [] })
  })

  test("a value a form cannot carry is refused before anything is sent", async () => {
    sent.length = 0
    const loose = api as unknown as {
      profile: { post: (body: Record<string, unknown>) => Promise<unknown> }
    }
    for (const bad of [{ nested: true }, [["a"]], new Date(0), () => 1, Symbol("x")]) {
      await expect(loose.profile.post({ avatar: png("me.png"), title: bad })).rejects.toThrow(
        TypeError,
      )
    }
    expect(sent).toHaveLength(0)
  })

  test("the server's validation failure comes back as a typed error", async () => {
    const result = await api.profile.post({
      title: "hello",
      count: 1,
      public: true,
      tags: [],
      avatar: new File(["<script>"], "me.png", { type: "image/png" }),
      photos: [],
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(422)
    expect(result.error).toEqual({
      error: "validation",
      issues: [{ message: "File type could not be recognized", path: ["avatar"] }],
    })
  })
})

describe("a form sent in-process", () => {
  const seen: Array<{ type: string | null; length: string | null; auth: string | null }> = []
  const backend = server()
    .onRequest((request) => {
      seen.push({
        type: request.headers.get("content-type"),
        length: request.headers.get("content-length"),
        auth: request.headers.get("authorization"),
      })
    })
    .post(
      "/avatar",
      { body: t.form({ title: t.string(), avatar: t.file() }), bodyLimit: 2048 },
      (c) => ({ title: c.body.title, size: c.body.avatar.size }),
    )
  const local = inProcessClient(backend)

  test("arrives framed, with the length a network peer would declare", async () => {
    seen.length = 0
    const result = await local.avatar.post(
      { title: "hello", avatar: png("me.png") },
      { headers: { authorization: "Bearer x" } },
    )
    expect(result.error).toBeNull()
    expect(result.data).toEqual({ title: "hello", size: PNG.length })
    expect(seen[0]?.type).toMatch(/^multipart\/form-data; boundary=/)
    expect(Number(seen[0]?.length)).toBeGreaterThan(PNG.length)
    expect(seen[0]?.auth).toBe("Bearer x")
  })

  test("a form over the route's limit is refused, not read", async () => {
    const big = new File([new Uint8Array(8192)], "big.bin")
    const result = await local.avatar.post({ title: "hello", avatar: big })
    expect(result.status).toBe(413)
    expect(result.error as unknown).toEqual({ error: "payload_too_large" })
  })
})

describe("a body without a file", () => {
  test("stays JSON", async () => {
    sent.length = 0
    const result = await api.notes.post({ title: "plain" })
    expect(result.data).toEqual({ title: "plain" })
    expect(typeof sent[0]?.body).toBe("string")
    expect(sent[0]?.contentType).toBe("application/json")
  })
})
