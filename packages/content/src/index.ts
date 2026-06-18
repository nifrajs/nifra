/**
 * Typed content collections for nifra — the **framework-agnostic core**. Parse a Markdown file's
 * frontmatter + body, validate the frontmatter against a Standard Schema (`@nifrajs/schema`'s `t`, zod,
 * valibot), and render the body to HTML. Pure (no filesystem, no DOM) so it runs anywhere — pair it
 * with `@nifrajs/content/fs`'s `defineCollection` for fs-backed discovery on Bun/Node/Deno + at build.
 *
 *   import { t } from "@nifrajs/schema"
 *   import { defineCollection } from "@nifrajs/content/fs"
 *
 *   const blog = defineCollection({
 *     dir: "content/blog",
 *     schema: t.object({ title: t.string(), date: t.string(), draft: t.boolean() }),
 *   })
 *
 *   // in a loader — typed + validated entries, no manual fs/frontmatter parsing:
 *   const posts = (await blog.all()).filter((p) => !p.frontmatter.draft)
 *   //    posts[0].frontmatter is { title: string; date: string; draft: boolean }
 *   //    posts[0].html is the rendered Markdown
 */
import { marked } from "marked"
import { parse as parseYaml } from "yaml"

/** A Standard Schema issue (the subset we surface). */
interface StandardIssue {
  readonly message: string
}

/**
 * Minimal [Standard Schema](https://standardschema.dev) shape — lets frontmatter validate against any
 * compliant validator (`@nifrajs/schema`'s `t`, zod, valibot, …) without coupling `@nifrajs/content` to one.
 */
export interface StandardSchemaV1<Output = unknown> {
  readonly "~standard": {
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value: Output; readonly issues?: undefined }
      | { readonly issues: ReadonlyArray<StandardIssue> }
      | Promise<
          | { readonly value: Output; readonly issues?: undefined }
          | { readonly issues: ReadonlyArray<StandardIssue> }
        >
  }
}

/** The validated output type of a schema. */
export type InferSchema<S> = S extends StandardSchemaV1<infer Output> ? Output : never

/** A parsed content entry: its slug, validated frontmatter, rendered HTML, and the raw Markdown body. */
export interface Entry<Frontmatter> {
  /** Identifier (e.g. the filename without extension). */
  readonly slug: string
  /** Frontmatter, validated + typed by the collection's schema. */
  readonly frontmatter: Frontmatter
  /** The body rendered to HTML (Markdown → HTML). */
  readonly html: string
  /** The raw Markdown body, with the frontmatter block stripped. */
  readonly body: string
}

// A leading `---` … `---` YAML frontmatter block. Tolerates CRLF and an optional trailing newline.
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** Split a raw content string into its (unvalidated) frontmatter data + the body. No frontmatter block
 * ⇒ `data` is `{}` and `body` is the whole input. */
export function parseFrontmatter(raw: string): { data: unknown; body: string } {
  const match = FRONTMATTER.exec(raw)
  if (match === null) return { data: {}, body: raw }
  const data = (parseYaml(match[1] ?? "") as unknown) ?? {}
  return { data, body: raw.slice(match[0].length) }
}

export interface ParseEntryOptions<S extends StandardSchemaV1> {
  readonly raw: string
  readonly slug: string
  /** Standard Schema validating the frontmatter — a typo'd/missing field throws (a build-time failure,
   * never a broken page). */
  readonly schema: S
}

/**
 * Parse one content file: split + validate its frontmatter against `schema`, render its Markdown body
 * to HTML. Throws a descriptive error (naming the slug + the issues) when the frontmatter is invalid —
 * surface it at build/load time rather than shipping a malformed entry. Pure + edge-safe.
 */
export async function parseEntry<S extends StandardSchemaV1>(
  options: ParseEntryOptions<S>,
): Promise<Entry<InferSchema<S>>> {
  const { data, body } = parseFrontmatter(options.raw)
  const result = await options.schema["~standard"].validate(data)
  if (result.issues !== undefined) {
    const detail = result.issues.map((issue) => issue.message).join("; ")
    throw new Error(`@nifrajs/content: invalid frontmatter in "${options.slug}": ${detail}`)
  }
  // `marked.parse` is sync by default but may be async with extensions — await covers both. Content is
  // author-controlled (your own files), so raw HTML in Markdown is passed through (standard SSG
  // behavior); sanitize yourself if a collection ever holds untrusted input.
  const html = await marked.parse(body)
  return { slug: options.slug, frontmatter: result.value as InferSchema<S>, html, body }
}

/**
 * A content collection baked to plain data — fs-free, so it works at the **edge** (Workers
 * request-time) where `defineCollection`'s `node:fs` reader can't run. Produce one at build/server time
 * with `bakeCollection`, JSON-serialize + ship it in the bundle, then rehydrate with `fromBaked`.
 */
export interface BakedCollection<Frontmatter> {
  readonly entries: ReadonlyArray<Entry<Frontmatter>>
}

/** Read-only collection surface (`all()`/`get()`) — structurally compatible with `defineCollection`'s
 * `Collection`, but with no filesystem access. */
export interface StaticCollection<Frontmatter> {
  all(): Promise<ReadonlyArray<Entry<Frontmatter>>>
  get(slug: string): Promise<Entry<Frontmatter> | null>
}

/**
 * Bake a collection's entries to serializable data at build/server time. The collection does the
 * filesystem read + validation (via `all()`); this just collects the already-parsed result so it can be
 * JSON-serialized into the edge bundle. Pure — safe to import anywhere.
 */
export async function bakeCollection<Frontmatter>(collection: {
  all(): Promise<ReadonlyArray<Entry<Frontmatter>>>
}): Promise<BakedCollection<Frontmatter>> {
  return { entries: await collection.all() }
}

/**
 * Rehydrate a baked collection into a read-only `all()`/`get()` collection — fs-free, edge-safe. The
 * entries were validated when baked (build output, trusted), so they're served as-is. `get` is O(1).
 */
export function fromBaked<Frontmatter>(
  baked: BakedCollection<Frontmatter>,
): StaticCollection<Frontmatter> {
  const entries = baked.entries
  const bySlug = new Map(entries.map((entry) => [entry.slug, entry]))
  return {
    all: () => Promise.resolve(entries),
    get: (slug) => Promise.resolve(bySlug.get(slug) ?? null),
  }
}
