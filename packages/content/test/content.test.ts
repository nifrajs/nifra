import { describe, expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { parseEntry, parseFrontmatter, type StandardSchemaV1 } from "../src/index.ts"

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
