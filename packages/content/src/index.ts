/**
 * Typed content collections for nifra - the **framework-agnostic core**. Parse a Markdown file's
 * frontmatter + body, validate the frontmatter against a Standard Schema (`@nifrajs/schema`'s `t`, zod,
 * valibot), and render the body to HTML. Pure (no filesystem, no DOM) so it runs anywhere - pair it
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
 *   // in a loader - typed + validated entries, no manual fs/frontmatter parsing:
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
 * Minimal [Standard Schema](https://standardschema.dev) shape - lets frontmatter validate against any
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
  /** Standard Schema validating the frontmatter - a typo'd/missing field throws (a build-time failure,
   * never a broken page). */
  readonly schema: S
}

/**
 * Parse one content file: split + validate its frontmatter against `schema`, render its Markdown body
 * to HTML. Throws a descriptive error (naming the slug + the issues) when the frontmatter is invalid -
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
  // `marked.parse` is sync by default but may be async with extensions - await covers both. Content is
  // author-controlled (your own files), so raw HTML in Markdown is passed through (standard SSG
  // behavior); sanitize yourself if a collection ever holds untrusted input.
  const html = await marked.parse(body)
  return { slug: options.slug, frontmatter: result.value as InferSchema<S>, html, body }
}

/**
 * A content collection baked to plain data - fs-free, so it works at the **edge** (Workers
 * request-time) where `defineCollection`'s `node:fs` reader can't run. Produce one at build/server time
 * with `bakeCollection`, JSON-serialize + ship it in the bundle, then rehydrate with `fromBaked`.
 */
export interface BakedCollection<Frontmatter> {
  readonly entries: ReadonlyArray<Entry<Frontmatter>>
}

/** Read-only collection surface (`all()`/`get()`) - structurally compatible with `defineCollection`'s
 * `Collection`, but with no filesystem access. */
export interface StaticCollection<Frontmatter> {
  all(): Promise<ReadonlyArray<Entry<Frontmatter>>>
  get(slug: string): Promise<Entry<Frontmatter> | null>
}

/**
 * Bake a collection's entries to serializable data at build/server time. The collection does the
 * filesystem read + validation (via `all()`); this just collects the already-parsed result so it can be
 * JSON-serialized into the edge bundle. Pure - safe to import anywhere.
 */
export async function bakeCollection<Frontmatter>(collection: {
  all(): Promise<ReadonlyArray<Entry<Frontmatter>>>
}): Promise<BakedCollection<Frontmatter>> {
  return { entries: await collection.all() }
}

/**
 * Rehydrate a baked collection into a read-only `all()`/`get()` collection - fs-free, edge-safe. The
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

/** A string frontmatter field name accepted by the index APIs. */
export type ContentFieldKey<Frontmatter extends Record<string, unknown>> = Extract<
  keyof Frontmatter,
  string
>

/** A declared sort order. Ties are always broken by slug, then source order. */
export interface IndexSort<Frontmatter extends Record<string, unknown>> {
  readonly field: ContentFieldKey<Frontmatter>
  readonly dir: "asc" | "desc"
}

/** Field-equality filters. Arbitrary predicates are intentionally not part of baked indexes. */
export type IndexWhere<Frontmatter extends Record<string, unknown>> = Partial<{
  [K in ContentFieldKey<Frontmatter>]: Frontmatter[K]
}>

/** Range operators are available for string and number fields only. */
export type IndexRange<Value> = [Extract<Value, string | number>] extends [never]
  ? never
  : {
      readonly gt?: Extract<Value, string | number>
      readonly gte?: Extract<Value, string | number>
      readonly lt?: Extract<Value, string | number>
      readonly lte?: Extract<Value, string | number>
    }

/** Typed range filters derived from the collection's frontmatter. */
export type IndexRanges<Frontmatter extends Record<string, unknown>> = Partial<{
  [K in ContentFieldKey<Frontmatter>]: IndexRange<Frontmatter[K]>
}>

/** A bounded, cursor-based index query. The cursor is opaque and tied to its filter + sort. */
export interface IndexQueryOptions<Frontmatter extends Record<string, unknown>> {
  readonly where?: IndexWhere<Frontmatter>
  readonly range?: IndexRanges<Frontmatter>
  readonly sort?: IndexSort<Frontmatter>
  readonly cursor?: string
  /** Defaults to 20; values above 100 are rejected to bound request-driven work. */
  readonly limit?: number
}

/** One page from an indexed collection. `nextCursor` is absent on the final page. */
export interface IndexPage<Frontmatter extends Record<string, unknown>> {
  readonly items: ReadonlyArray<Entry<Frontmatter>>
  readonly nextCursor?: string
}

/** The JSON-safe lookup bucket stored in a baked index. */
export interface BakedIndexBucket {
  readonly key: string
  readonly entryIndexes: ReadonlyArray<number>
}

/** JSON-safe index data. It contains no functions, Map, Set, filesystem handle, or request data. */
export interface BakedCollectionIndex<
  Frontmatter extends Record<string, unknown>,
  By extends ContentFieldKey<Frontmatter>,
> {
  readonly entries: ReadonlyArray<Entry<Frontmatter>>
  readonly by: By
  readonly sort: IndexSort<Frontmatter>
  /** Entry indexes in the default deterministic order. */
  readonly order: ReadonlyArray<number>
  readonly buckets: ReadonlyArray<BakedIndexBucket>
}

/** A build-time/runtime index over validated, baked entries. */
export interface IndexedCollection<
  Frontmatter extends Record<string, unknown>,
  By extends ContentFieldKey<Frontmatter>,
> {
  readonly entries: ReadonlyArray<Entry<Frontmatter>>
  readonly by: By
  readonly baked: BakedCollectionIndex<Frontmatter, By>
  /** O(1) lookup after the build/rehydration map is constructed. Missing keys return no rows. */
  readonly lookup: (value: Frontmatter[By]) => ReadonlyArray<Entry<Frontmatter>>
  /** All entries in the index's default stable order. */
  readonly all: () => ReadonlyArray<Entry<Frontmatter>>
  readonly query: (options?: IndexQueryOptions<Frontmatter>) => IndexPage<Frontmatter>
}

/** Keys whose frontmatter value types are identical on both sides of a join. */
export type SharedKey<
  Left extends Record<string, unknown>,
  Right extends Record<string, unknown>,
> = {
  [K in ContentFieldKey<Left> & ContentFieldKey<Right>]: [Left[K]] extends [Right[K]]
    ? [Right[K]] extends [Left[K]]
      ? K
      : never
    : never
}[ContentFieldKey<Left> & ContentFieldKey<Right>]

export type JoinCardinality = "one-to-many" | "one-to-one"

export type JoinedRow<
  Left extends Record<string, unknown>,
  Right extends Record<string, unknown>,
  Cardinality extends JoinCardinality,
> = {
  readonly left: Entry<Left>
  readonly right: Cardinality extends "one-to-one"
    ? Entry<Right> | null
    : ReadonlyArray<Entry<Right>>
}

/** JSON-safe joined rows, ordered by the left index and then the right index. */
export interface BakedCollectionJoin<
  Left extends Record<string, unknown>,
  Right extends Record<string, unknown>,
  On extends SharedKey<Left, Right>,
  Cardinality extends JoinCardinality,
> {
  readonly on: On
  readonly cardinality: Cardinality
  readonly rows: ReadonlyArray<JoinedRow<Left, Right, Cardinality>>
}

/** A deterministic cross-collection join. No database or network layer is involved. */
export interface IndexedJoin<
  Left extends Record<string, unknown>,
  Right extends Record<string, unknown>,
  On extends SharedKey<Left, Right>,
  Cardinality extends JoinCardinality,
> {
  readonly entries: ReadonlyArray<JoinedRow<Left, Right, Cardinality>>
  readonly baked: BakedCollectionJoin<Left, Right, On, Cardinality>
}

export interface IndexOptions<
  Frontmatter extends Record<string, unknown>,
  By extends ContentFieldKey<Frontmatter>,
> {
  readonly by: By
  readonly sort?: IndexSort<Frontmatter>
}

const DEFAULT_INDEX_PAGE_SIZE = 20
const MAX_INDEX_PAGE_SIZE = 100
const MAX_CURSOR_LENGTH = 4096

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Stable JSON for frontmatter keys/filter fingerprints. It rejects values JSON cannot preserve. */
const stableJson = (value: unknown, seen = new Set<object>()): string | undefined => {
  if (value === undefined) return undefined
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number")
    return JSON.stringify(value)
  }
  if (typeof value !== "object") throw new TypeError("non-JSON value")
  if (seen.has(value)) throw new TypeError("cyclic value")
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const items = value.map((item) => {
        const encoded = stableJson(item, seen)
        if (encoded === undefined) throw new TypeError("undefined array item")
        return encoded
      })
      return `[${items.join(",")}]`
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError("non-plain object")
    const fields: string[] = []
    for (const key of Object.keys(value).sort()) {
      const encoded = stableJson(Reflect.get(value, key), seen)
      if (encoded === undefined) throw new TypeError("undefined object field")
      fields.push(`${JSON.stringify(key)}:${encoded}`)
    }
    return `{${fields.join(",")}}`
  } finally {
    seen.delete(value)
  }
}

const keyFor = (value: unknown, field: string): string | undefined => {
  try {
    return stableJson(value)
  } catch {
    throw new TypeError(`@nifrajs/content: field "${field}" is not JSON-indexable`)
  }
}

const compareValues = (left: unknown, right: unknown): number => {
  if (left === right) return 0
  if (left === undefined) return 1
  if (right === undefined) return -1
  if (typeof left === "number" && typeof right === "number") return left < right ? -1 : 1
  if (typeof left === "string" && typeof right === "string") return left < right ? -1 : 1
  if (typeof left === "boolean" && typeof right === "boolean") return left ? 1 : -1
  const leftKey = stableJson(left) ?? ""
  const rightKey = stableJson(right) ?? ""
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
}

const compareEntries = <Frontmatter extends Record<string, unknown>>(
  entries: ReadonlyArray<Entry<Frontmatter>>,
  leftIndex: number,
  rightIndex: number,
  sort: IndexSort<Frontmatter>,
): number => {
  const left = entries[leftIndex]
  const right = entries[rightIndex]
  if (left === undefined || right === undefined) return left === undefined ? 1 : -1
  let result = compareValues(left.frontmatter[sort.field], right.frontmatter[sort.field])
  if (sort.dir === "desc") result = -result
  if (result !== 0) return result
  result = left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0
  return result !== 0 ? result : leftIndex - rightIndex
}

const sortedOrder = <Frontmatter extends Record<string, unknown>>(
  entries: ReadonlyArray<Entry<Frontmatter>>,
  sort: IndexSort<Frontmatter>,
): number[] =>
  entries.map((_, index) => index).sort((left, right) => compareEntries(entries, left, right, sort))

const assertPageSize = (value: number | undefined): number => {
  const limit = value ?? DEFAULT_INDEX_PAGE_SIZE
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_INDEX_PAGE_SIZE) {
    throw new RangeError(
      `@nifrajs/content: index page limit must be an integer from 1 to ${MAX_INDEX_PAGE_SIZE}`,
    )
  }
  return limit
}

const filterFingerprint = (where: unknown, range: unknown): string => {
  try {
    return stableJson({ where: where ?? null, range: range ?? null }) ?? "null"
  } catch {
    throw new TypeError("@nifrajs/content: index filters must contain JSON values")
  }
}

interface CursorPayload {
  readonly v: 1
  readonly sortField: string
  readonly dir: "asc" | "desc"
  readonly filter: string
  readonly position: number
}

const encodeCursor = (payload: CursorPayload): string => encodeURIComponent(JSON.stringify(payload))

const decodeCursor = (cursor: string): CursorPayload => {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) {
    throw new TypeError("@nifrajs/content: invalid index cursor")
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeURIComponent(cursor))
  } catch {
    throw new TypeError("@nifrajs/content: invalid index cursor")
  }
  if (!isRecord(parsed)) throw new TypeError("@nifrajs/content: invalid index cursor")
  const version = parsed.v
  const sortField = parsed.sortField
  const dir = parsed.dir
  const filter = parsed.filter
  const position = parsed.position
  if (
    version !== 1 ||
    typeof sortField !== "string" ||
    (dir !== "asc" && dir !== "desc") ||
    typeof filter !== "string" ||
    typeof position !== "number" ||
    !Number.isSafeInteger(position) ||
    position < -1
  ) {
    throw new TypeError("@nifrajs/content: invalid index cursor")
  }
  return { v: 1, sortField, dir, filter, position }
}

const createIndexedCollection = <
  Frontmatter extends Record<string, unknown>,
  By extends ContentFieldKey<Frontmatter>,
>(
  baked: BakedCollectionIndex<Frontmatter, By>,
): IndexedCollection<Frontmatter, By> => {
  if (
    typeof baked.by !== "string" ||
    !isRecord(baked.sort) ||
    typeof baked.sort.field !== "string" ||
    (baked.sort.dir !== "asc" && baked.sort.dir !== "desc") ||
    !Array.isArray(baked.entries) ||
    !Array.isArray(baked.order) ||
    !Array.isArray(baked.buckets)
  ) {
    throw new TypeError("@nifrajs/content: malformed baked index")
  }
  const order = [...baked.order]
  const seenIndexes = new Set<number>()
  for (const index of order) {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= baked.entries.length ||
      seenIndexes.has(index)
    ) {
      throw new TypeError("@nifrajs/content: malformed baked index order")
    }
    seenIndexes.add(index)
  }
  if (seenIndexes.size !== baked.entries.length) {
    throw new TypeError("@nifrajs/content: malformed baked index order")
  }
  const lookup = new Map<string, number[]>()
  const bucketIndexes = new Set<number>()
  for (const bucket of baked.buckets) {
    if (
      !isRecord(bucket) ||
      typeof bucket.key !== "string" ||
      !Array.isArray(bucket.entryIndexes)
    ) {
      throw new TypeError("@nifrajs/content: malformed baked index bucket")
    }
    if (lookup.has(bucket.key))
      throw new TypeError("@nifrajs/content: duplicate baked index bucket")
    const indexes: number[] = []
    for (const index of bucket.entryIndexes) {
      if (!Number.isSafeInteger(index) || !seenIndexes.has(index)) {
        throw new TypeError("@nifrajs/content: malformed baked index bucket")
      }
      if (bucketIndexes.has(index)) {
        throw new TypeError("@nifrajs/content: duplicate baked index entry")
      }
      bucketIndexes.add(index)
      indexes.push(index)
    }
    lookup.set(bucket.key, indexes)
  }
  const entries = baked.entries
  const orderedEntries = (): ReadonlyArray<Entry<Frontmatter>> =>
    order.flatMap((index) => {
      const entry = entries[index]
      return entry === undefined ? [] : [entry]
    })
  const all = (): ReadonlyArray<Entry<Frontmatter>> => orderedEntries()
  const query = (options: IndexQueryOptions<Frontmatter> = {}): IndexPage<Frontmatter> => {
    const limit = assertPageSize(options.limit)
    const where = options.where
    const range = options.range
    if (where !== undefined && !isRecord(where)) {
      throw new TypeError("@nifrajs/content: index where must be an object")
    }
    if (range !== undefined && !isRecord(range)) {
      throw new TypeError("@nifrajs/content: index range must be an object")
    }
    const sort = options.sort ?? baked.sort
    if (
      !isRecord(sort) ||
      typeof sort.field !== "string" ||
      (sort.dir !== "asc" && sort.dir !== "desc")
    ) {
      throw new TypeError("@nifrajs/content: malformed index sort")
    }
    const filter = filterFingerprint(where, range)
    const queryOrder =
      sort.field === baked.sort.field && sort.dir === baked.sort.dir
        ? order
        : sortedOrder(entries, sort)
    const filtered = queryOrder.filter((index) => {
      const entry = entries[index]
      if (entry === undefined) return false
      const frontmatter: Record<string, unknown> = entry.frontmatter
      if (where !== undefined) {
        for (const [field, expected] of Object.entries(where)) {
          if (!Object.hasOwn(frontmatter, field)) return false
          if (keyFor(frontmatter[field], field) !== keyFor(expected, field)) return false
        }
      }
      if (range !== undefined) {
        for (const [field, rawRule] of Object.entries(range)) {
          if (!Object.hasOwn(frontmatter, field) || !isRecord(rawRule)) {
            throw new TypeError("@nifrajs/content: malformed index range")
          }
          const actual = frontmatter[field]
          if (
            typeof actual !== "string" &&
            (typeof actual !== "number" || !Number.isFinite(actual))
          ) {
            return false
          }
          for (const operator of ["gt", "gte", "lt", "lte"] as const) {
            if (!Object.hasOwn(rawRule, operator)) continue
            const expected = rawRule[operator]
            if (
              (typeof expected !== "string" &&
                (typeof expected !== "number" || !Number.isFinite(expected))) ||
              typeof expected !== typeof actual
            ) {
              throw new TypeError("@nifrajs/content: malformed index range")
            }
            const comparison = compareValues(actual, expected)
            if (
              (operator === "gt" && comparison <= 0) ||
              (operator === "gte" && comparison < 0) ||
              (operator === "lt" && comparison >= 0) ||
              (operator === "lte" && comparison > 0)
            ) {
              return false
            }
          }
        }
      }
      return true
    })
    const cursor = options.cursor === undefined ? undefined : decodeCursor(options.cursor)
    let start = 0
    if (cursor !== undefined) {
      if (
        cursor.sortField !== String(sort.field) ||
        cursor.dir !== sort.dir ||
        cursor.filter !== filter ||
        cursor.position >= filtered.length
      ) {
        if (cursor.position !== filtered.length - 1) {
          throw new TypeError("@nifrajs/content: cursor does not match this index query")
        }
        start = filtered.length
      } else {
        start = cursor.position + 1
      }
    }
    const pageIndexes = filtered.slice(start, start + limit)
    const items = pageIndexes.flatMap((index) => {
      const entry = entries[index]
      return entry === undefined ? [] : [entry]
    })
    const end = start + items.length
    return end < filtered.length
      ? {
          items,
          nextCursor: encodeCursor({
            v: 1,
            sortField: String(sort.field),
            dir: sort.dir,
            filter,
            position: end - 1,
          }),
        }
      : { items }
  }
  return {
    entries,
    by: baked.by,
    baked,
    lookup: (value) => {
      const key = keyFor(value, String(baked.by))
      if (key === undefined) return []
      return (lookup.get(key) ?? []).flatMap((index) => {
        const entry = entries[index]
        return entry === undefined ? [] : [entry]
      })
    },
    all,
    query,
  }
}

/** Build a deterministic typed index from already validated baked entries. */
export function indexCollection<
  Frontmatter extends Record<string, unknown>,
  By extends ContentFieldKey<Frontmatter>,
>(
  baked: BakedCollection<Frontmatter>,
  options: IndexOptions<Frontmatter, By>,
): IndexedCollection<Frontmatter, By> {
  const sort = options.sort ?? { field: options.by, dir: "asc" as const }
  const order = sortedOrder(baked.entries, sort)
  const buckets = new Map<string, number[]>()
  for (const index of order) {
    const entry = baked.entries[index]
    if (entry === undefined) continue
    const value = entry.frontmatter[options.by]
    const key = keyFor(value, String(options.by))
    if (key === undefined) continue
    const indexes = buckets.get(key)
    if (indexes === undefined) buckets.set(key, [index])
    else indexes.push(index)
  }
  const bakedIndex: BakedCollectionIndex<Frontmatter, By> = {
    entries: baked.entries,
    by: options.by,
    sort,
    order,
    buckets: [...buckets].map(([key, entryIndexes]) => ({ key, entryIndexes })),
  }
  return createIndexedCollection(bakedIndex)
}

/** Rehydrate a JSON-serialized index at the edge without filesystem access. */
export function fromBakedIndex<
  Frontmatter extends Record<string, unknown>,
  By extends ContentFieldKey<Frontmatter>,
>(baked: BakedCollectionIndex<Frontmatter, By>): IndexedCollection<Frontmatter, By> {
  return createIndexedCollection(baked)
}

const buildJoin = <
  Left extends Record<string, unknown>,
  Right extends Record<string, unknown>,
  LeftBy extends ContentFieldKey<Left>,
  RightBy extends ContentFieldKey<Right>,
  On extends SharedKey<Left, Right>,
  Cardinality extends JoinCardinality,
>(
  left: IndexedCollection<Left, LeftBy>,
  right: IndexedCollection<Right, RightBy>,
  on: On,
  cardinality: Cardinality,
): IndexedJoin<Left, Right, On, Cardinality> => {
  const rightByKey = new Map<string, Entry<Right>[]>()
  for (const index of right.baked.order) {
    const entry = right.entries[index]
    if (entry === undefined) continue
    const key = keyFor(entry.frontmatter[on], String(on))
    if (key === undefined) continue
    const existing = rightByKey.get(key)
    if (existing === undefined) rightByKey.set(key, [entry])
    else {
      if (cardinality === "one-to-one") {
        throw new Error(`@nifrajs/content: duplicate right join key for "${String(on)}"`)
      }
      existing.push(entry)
    }
  }
  const rows: Array<JoinedRow<Left, Right, Cardinality>> = []
  for (const index of left.baked.order) {
    const entry = left.entries[index]
    if (entry === undefined) continue
    const key = keyFor(entry.frontmatter[on], String(on))
    const matches = key === undefined ? undefined : rightByKey.get(key)
    rows.push({
      left: entry,
      right: (cardinality === "one-to-one"
        ? (matches?.[0] ?? null)
        : [...(matches ?? [])]) as JoinedRow<Left, Right, Cardinality>["right"],
    })
  }
  const baked: BakedCollectionJoin<Left, Right, On, Cardinality> = {
    on,
    cardinality,
    rows,
  }
  return { entries: rows, baked }
}

/** Join two indexes on a real same-typed frontmatter key. Default cardinality is one-to-many. */
export function joinCollections<
  Left extends Record<string, unknown>,
  Right extends Record<string, unknown>,
  LeftBy extends ContentFieldKey<Left>,
  RightBy extends ContentFieldKey<Right>,
  On extends SharedKey<Left, Right>,
>(
  left: IndexedCollection<Left, LeftBy>,
  right: IndexedCollection<Right, RightBy>,
  on: On,
  options?: { readonly cardinality?: "one-to-many" },
): IndexedJoin<Left, Right, On, "one-to-many">
export function joinCollections<
  Left extends Record<string, unknown>,
  Right extends Record<string, unknown>,
  LeftBy extends ContentFieldKey<Left>,
  RightBy extends ContentFieldKey<Right>,
  On extends SharedKey<Left, Right>,
>(
  left: IndexedCollection<Left, LeftBy>,
  right: IndexedCollection<Right, RightBy>,
  on: On,
  options: { readonly cardinality: "one-to-one" },
): IndexedJoin<Left, Right, On, "one-to-one">
export function joinCollections<
  Left extends Record<string, unknown>,
  Right extends Record<string, unknown>,
  LeftBy extends ContentFieldKey<Left>,
  RightBy extends ContentFieldKey<Right>,
  On extends SharedKey<Left, Right>,
>(
  left: IndexedCollection<Left, LeftBy>,
  right: IndexedCollection<Right, RightBy>,
  on: On,
  options?: { readonly cardinality?: JoinCardinality },
): IndexedJoin<Left, Right, On, JoinCardinality> {
  const cardinality = options?.cardinality ?? "one-to-many"
  return buildJoin(left, right, on, cardinality)
}

/** Rehydrate a deterministic join artifact. */
export function fromBakedJoin<
  Left extends Record<string, unknown>,
  Right extends Record<string, unknown>,
  On extends SharedKey<Left, Right>,
  Cardinality extends JoinCardinality,
>(
  baked: BakedCollectionJoin<Left, Right, On, Cardinality>,
): IndexedJoin<Left, Right, On, Cardinality> {
  if (!isRecord(baked) || !Array.isArray(baked.rows)) {
    throw new TypeError("@nifrajs/content: malformed baked join")
  }
  if (baked.cardinality !== "one-to-many" && baked.cardinality !== "one-to-one") {
    throw new TypeError("@nifrajs/content: malformed baked join")
  }
  for (const row of baked.rows) {
    if (!isRecord(row) || !isRecord(row.left)) {
      throw new TypeError("@nifrajs/content: malformed baked join row")
    }
    const validRight =
      baked.cardinality === "one-to-many"
        ? Array.isArray(row.right)
        : row.right === null || isRecord(row.right)
    if (!validRight) throw new TypeError("@nifrajs/content: malformed baked join row")
  }
  return { entries: baked.rows, baked }
}
