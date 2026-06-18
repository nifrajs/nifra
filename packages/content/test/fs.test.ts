import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { t } from "@nifrajs/schema"
import { defineCollection } from "../src/fs.ts"
import { bakeCollection, fromBaked, type StandardSchemaV1 } from "../src/index.ts"

const blog = defineCollection({
  dir: join(import.meta.dir, "fixtures", "blog"),
  schema: t.object({ title: t.string(), date: t.string(), draft: t.boolean() }),
})

test("all() discovers, parses, validates, and renders every file (sorted by filename)", async () => {
  const posts = await blog.all()
  expect(posts.map((p) => p.slug)).toEqual(["first-post", "second-post"])
  expect(posts[0]?.frontmatter).toEqual({ title: "First Post", date: "2026-01-01", draft: false })
  expect(posts[0]?.html).toContain("<h1>First</h1>")
  expect(posts[0]?.html).toContain('<a href="/docs">link</a>')
  // typed + usable in a loader: filter drafts
  expect(posts.filter((p) => !p.frontmatter.draft).map((p) => p.slug)).toEqual(["first-post"])
})

test("get(slug) loads one entry; returns null for a missing slug", async () => {
  expect((await blog.get("second-post"))?.frontmatter.title).toBe("Second Post")
  expect(await blog.get("does-not-exist")).toBeNull()
})

test("get(slug) rejects path traversal and encoded slash route params", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nifra-content-"))
  try {
    mkdirSync(join(dir, "posts"))
    writeFileSync(
      join(dir, "posts", "public.md"),
      "---\ntitle: Public\ndate: 2026-01-01\ndraft: false\n---\n# Public",
    )
    writeFileSync(
      join(dir, "secret.md"),
      "---\ntitle: Secret\ndate: 2026-01-01\ndraft: false\n---\n# Secret",
    )
    const posts = defineCollection({
      dir: join(dir, "posts"),
      schema: t.object({ title: t.string(), date: t.string(), draft: t.boolean() }),
    })
    expect((await posts.get("public"))?.frontmatter.title).toBe("Public")
    expect(await posts.get("../secret")).toBeNull()
    expect(await posts.get("..")).toBeNull()
    expect(await posts.get("nested/secret")).toBeNull()
    // The router decodes `/blog/%2e%2e%2fsecret` to `../secret`; guard the collection boundary here.
    expect(await posts.get(decodeURIComponent("%2e%2e%2fsecret"))).toBeNull()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("defineCollection rejects unsafe extension configuration", () => {
  expect(() =>
    defineCollection({
      dir: join(import.meta.dir, "fixtures", "blog"),
      schema: t.object({ title: t.string() }),
      extensions: ["../md"],
    }),
  ).toThrow(/invalid extension/)
})

test("all() reuses parsed entries until files change", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nifra-content-cache-"))
  let validations = 0
  const schema = {
    "~standard": {
      validate(value) {
        validations++
        const data = value as { title?: unknown }
        return typeof data.title === "string"
          ? { value: { title: data.title } }
          : { issues: [{ message: "title required" }] }
      },
    },
  } satisfies StandardSchemaV1<{ title: string }>

  try {
    writeFileSync(join(dir, "post.md"), "---\ntitle: First\n---\n# First")
    const posts = defineCollection({ dir, schema })

    expect((await posts.all())[0]?.frontmatter.title).toBe("First")
    expect((await posts.all())[0]?.frontmatter.title).toBe("First")
    expect(validations).toBe(1)

    writeFileSync(join(dir, "post.md"), "---\ntitle: Updated\n---\n# Updated body")
    expect((await posts.all())[0]?.frontmatter.title).toBe("Updated")
    expect(validations).toBe(2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("bakeCollection + fromBaked: fs collection → serializable → edge-safe reader (no fs)", async () => {
  const baked = await bakeCollection(blog)
  expect(baked.entries.map((e) => e.slug)).toEqual(["first-post", "second-post"])
  // Survives JSON serialization — this is what ships in the edge (Workers) bundle.
  const shipped = JSON.parse(JSON.stringify(baked)) as typeof baked
  const edge = fromBaked(shipped)
  expect((await edge.all()).map((e) => e.slug)).toEqual(["first-post", "second-post"])
  expect((await edge.get("second-post"))?.frontmatter.title).toBe("Second Post")
  expect((await edge.get("first-post"))?.html).toContain("<h1>First</h1>")
  expect(await edge.get("missing")).toBeNull()
})
