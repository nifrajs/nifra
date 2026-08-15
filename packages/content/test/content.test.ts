import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import {
  type BakedCollection,
  fromBakedIndex,
  indexCollection,
  joinCollections,
  parseEntry,
  parseFrontmatter,
  type StandardSchemaV1,
} from "../src/index.ts"

const schema = t.object({ title: t.string(), draft: t.boolean() })

describe("parseFrontmatter", () => {
  test("splits a --- block (and tolerates CRLF)", () => {
    expect(parseFrontmatter("---\ntitle: X\n---\nbody here")).toEqual({
      data: { title: "X" },
      body: "body here",
    })
    expect(parseFrontmatter("---\r\ntitle: X\r\n---\r\nbody").body).toBe("body")
  })

  test("no block → empty data + the whole input as body", () => {
    expect(parseFrontmatter("# just markdown")).toEqual({ data: {}, body: "# just markdown" })
  })
})

describe("parseEntry", () => {
  test("validates + types frontmatter and renders the Markdown body", async () => {
    const entry = await parseEntry({
      raw: "---\ntitle: Hi\ndraft: false\n---\n# Heading\n\n**bold**",
      slug: "x",
      schema,
    })
    expect(entry.slug).toBe("x")
    expect(entry.frontmatter).toEqual({ title: "Hi", draft: false })
    expect(entry.html).toContain("<h1>Heading</h1>")
    expect(entry.html).toContain("<strong>bold</strong>")
    expect(entry.body.trim()).toBe("# Heading\n\n**bold**")
  })

  test("throws (naming the slug) when frontmatter is invalid", async () => {
    await expect(
      parseEntry({ raw: "---\ntitle: 123\ndraft: false\n---\nx", slug: "bad-post", schema }),
    ).rejects.toThrow(/invalid frontmatter in "bad-post"/)
  })

  test("throws when required frontmatter is missing entirely (no block)", async () => {
    await expect(parseEntry({ raw: "# no frontmatter", slug: "nf", schema })).rejects.toThrow(
      /invalid frontmatter/,
    )
  })

  test("awaits an async schema validator", async () => {
    const asyncSchema: StandardSchemaV1<{ title: string }> = {
      "~standard": {
        validate: async (value) =>
          typeof (value as { title?: unknown }).title === "string"
            ? { value: value as { title: string } }
            : { issues: [{ message: "title required" }] },
      },
    }
    const entry = await parseEntry({
      raw: "---\ntitle: Async\n---\nx",
      slug: "a",
      schema: asyncSchema,
    })
    expect(entry.frontmatter.title).toBe("Async")
  })
})

type Post = { id: string; title: string; score: number; section: string }
type Author = { id: string; name: string }

const posts: BakedCollection<Post> = {
  entries: [
    {
      slug: "b",
      frontmatter: { id: "2", title: "B", score: 2, section: "news" },
      html: "",
      body: "",
    },
    {
      slug: "a",
      frontmatter: { id: "1", title: "A", score: 3, section: "news" },
      html: "",
      body: "",
    },
    {
      slug: "c",
      frontmatter: { id: "3", title: "C", score: 1, section: "sports" },
      html: "",
      body: "",
    },
  ],
}

describe("content indexes", () => {
  test("builds deterministic lookup, stable sort, filters, ranges, and cursor pages", () => {
    const index = indexCollection(posts, { by: "section", sort: { field: "score", dir: "desc" } })
    expect(index.lookup("news").map((entry) => entry.slug)).toEqual(["a", "b"])
    expect(index.all().map((entry) => entry.slug)).toEqual(["a", "b", "c"])

    const first = index.query({ range: { score: { gte: 2 } }, limit: 1 })
    expect(first.items.map((entry) => entry.slug)).toEqual(["a"])
    expect(first.nextCursor).toBeString()
    if (first.nextCursor === undefined) throw new Error("expected a next cursor")
    const second = index.query({ range: { score: { gte: 2 } }, limit: 1, cursor: first.nextCursor })
    expect(second.items.map((entry) => entry.slug)).toEqual(["b"])
    expect(second.nextCursor).toBeUndefined()
    expect(index.query({ where: { section: "sports" } }).items.map((entry) => entry.slug)).toEqual([
      "c",
    ])

    const restored = fromBakedIndex(structuredClone(index.baked))
    expect(JSON.stringify(restored.baked)).toBe(JSON.stringify(index.baked))
    expect(restored.query({ limit: 10 }).items.map((entry) => entry.slug)).toEqual(["a", "b", "c"])
  })

  test("rejects unsupported indexed values and malformed cursors", () => {
    const unsupported: BakedCollection<{ value: Date }> = {
      entries: [{ slug: "x", frontmatter: { value: new Date(0) }, html: "", body: "" }],
    }
    expect(() => indexCollection(unsupported, { by: "value" })).toThrow(/not JSON-indexable/)
    const index = indexCollection(posts, { by: "section" })
    expect(() => index.query({ cursor: "not-a-cursor" })).toThrow(/invalid index cursor/)
  })

  test("joins one-to-many by a same-typed key and rejects duplicate one-to-one rights", () => {
    const left = indexCollection(posts, { by: "id" })
    const authors: BakedCollection<Author> = {
      entries: [
        { slug: "ada", frontmatter: { id: "1", name: "Ada" }, html: "", body: "" },
        { slug: "grace", frontmatter: { id: "1", name: "Grace" }, html: "", body: "" },
        { slug: "linus", frontmatter: { id: "9", name: "Linus" }, html: "", body: "" },
      ],
    }
    const right = indexCollection(authors, { by: "id" })
    const joined = joinCollections(left, right, "id")
    expect(joined.entries[0]?.right.map((entry) => entry.slug)).toEqual(["ada", "grace"])
    expect(joined.entries[1]?.right).toEqual([])
    expect(() => joinCollections(left, right, "id", { cardinality: "one-to-one" })).toThrow(
      /duplicate right join key/,
    )

    const unique = joinCollections(
      left,
      indexCollection({ entries: [authors.entries[0]!] }, { by: "id" }),
      "id",
      { cardinality: "one-to-one" },
    )
    expect(unique.entries[0]?.right?.slug).toBe("ada")
    expect(unique.entries[1]?.right).toBeNull()
  })

  test("same-value-type join keys are enforced by TypeScript", () => {
    type Bad = { id: number }
    const bad = indexCollection<Bad, "id">(
      { entries: [{ slug: "bad", frontmatter: { id: 1 }, html: "", body: "" }] },
      { by: "id" },
    )
    const left = indexCollection(posts, { by: "id" })
    const compileOnly = (): void => {
      // @ts-expect-error string and number join keys must not silently join
      joinCollections(left, bad, "id")
    }
    void compileOnly
  })
})
