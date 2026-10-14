/**
 * Filesystem-backed content collections - `defineCollection` reads a directory of Markdown files and
 * gives you a typed, validated API over them. Build/server-time (Bun/Node/Deno); for the edge, bake the
 * entries at build (the manifest approach `@nifrajs/web/fs` uses for routes) - tracked as a follow-up.
 */
import type { Stats } from "node:fs"
import { readdir, readFile, stat as statPath } from "node:fs/promises"
import { resolve, sep } from "node:path"
import { type Entry, type InferSchema, parseEntry, type StandardSchemaV1 } from "./index.ts"

export interface CollectionConfig<S extends StandardSchemaV1> {
  /** Directory of content files, relative to the process cwd (or absolute). */
  readonly dir: string
  /** Standard Schema validating each file's frontmatter. */
  readonly schema: S
  /** File extensions to include (default `[".md", ".markdown"]`). */
  readonly extensions?: readonly string[]
  /** Look for changes on every `all()` (default `true`): a directory listing and a `stat` per file,
   * so an edit shows without a restart. `false` lists and parses the directory once and returns that
   * snapshot from then on, for a server whose content ships with its build. `get` checks its one
   * file either way. */
  readonly watch?: boolean
}

/** A typed collection over a content directory. */
export interface Collection<Frontmatter> {
  /** Every entry in the directory (unordered - sort/filter in your loader). Throws if any file's
   * frontmatter is invalid. */
  all(): Promise<Array<Entry<Frontmatter>>>
  /** One entry by slug (filename without extension), or `null` if not found. Throws, as `all()`
   * does, if the file's frontmatter is invalid. */
  get(slug: string): Promise<Entry<Frontmatter> | null>
}

const DEFAULT_EXTENSIONS = [".md", ".markdown"] as const

const slugOf = (file: string): string => file.replace(/\.[^.]+$/, "")

const isSafeSlug = (slug: string): boolean =>
  slug !== "." &&
  slug !== ".." &&
  !slug.includes("/") &&
  !slug.includes("\\") &&
  !slug.includes("\0")

const assertSafeExtensions = (extensions: readonly string[]): void => {
  for (const ext of extensions) {
    if (!ext.startsWith(".") || ext.includes("/") || ext.includes("\\") || ext.includes("\0")) {
      throw new Error(`@nifrajs/content: invalid extension "${ext}"`)
    }
  }
}

const insideRoot = (root: string, file: string): boolean =>
  file !== root && file.startsWith(`${root}${sep}`)

interface FileRecord {
  readonly file: string
  readonly path: string
  readonly stamp: string
}

interface CachedEntry<Frontmatter> {
  readonly stamp: string
  readonly entry: Entry<Frontmatter>
}

interface CollectionSnapshot<Frontmatter> {
  readonly fingerprint: string
  readonly entries: Array<Entry<Frontmatter>>
}

/**
 * Define a content collection backed by a directory. `all()` discovers + parses every matching file;
 * `get(slug)` loads one. Frontmatter is validated against `schema`, so entries are fully typed and a
 * malformed file fails loudly. Reads the filesystem - use it at build time (SSG/prerender) or on a
 * long-lived server (Bun/Node/Deno).
 */
export function defineCollection<S extends StandardSchemaV1>(
  config: CollectionConfig<S>,
): Collection<InferSchema<S>> {
  const extensions = config.extensions ?? DEFAULT_EXTENSIONS
  assertSafeExtensions(extensions)
  const root = resolve(config.dir)
  const matches = (file: string): boolean => extensions.some((ext) => file.endsWith(ext))
  const fileCache = new Map<string, CachedEntry<InferSchema<S>>>()
  let collectionCache: CollectionSnapshot<InferSchema<S>> | undefined
  let frozen: Promise<Array<Entry<InferSchema<S>>>> | undefined

  const readEntry = async (
    path: string,
    slug: string,
    stamp: string,
  ): Promise<Entry<InferSchema<S>>> => {
    const cached = fileCache.get(path)
    if (cached?.stamp === stamp) return cached.entry
    const entry = await parseEntry({
      raw: await readFile(path, "utf8"),
      slug,
      schema: config.schema,
    })
    fileCache.set(path, { stamp, entry })
    return entry
  }

  // Async throughout: a collection read on a long-lived server must not block its event loop.
  const listFiles = async (): Promise<FileRecord[]> => {
    const files = (await readdir(root)).filter(matches).sort()
    return Promise.all(
      files.map(async (file) => {
        const path = resolve(root, file)
        const stat = await statPath(path)
        return { file, path, stamp: `${stat.mtimeMs}:${stat.size}` }
      }),
    )
  }

  const load = async (): Promise<Array<Entry<InferSchema<S>>>> => {
    const files = await listFiles()
    const fingerprint = files.map((file) => `${file.file}\0${file.stamp}`).join("\0")
    if (collectionCache?.fingerprint === fingerprint) return collectionCache.entries

    const listed = new Set(files.map((file) => file.path))
    for (const path of fileCache.keys()) if (!listed.has(path)) fileCache.delete(path)
    const entries = await Promise.all(
      files.map((file) => readEntry(file.path, slugOf(file.file), file.stamp)),
    )
    collectionCache = {
      fingerprint,
      entries,
    }
    return entries
  }

  return {
    async all() {
      if (config.watch !== false) return [...(await load())]
      // A failed first read is not kept, so the next call retries it.
      frozen ??= load().catch((error: unknown) => {
        frozen = undefined
        throw error
      })
      return [...(await frozen)]
    },
    async get(slug) {
      if (!isSafeSlug(slug)) return null

      for (const ext of extensions) {
        const file = resolve(root, `${slug}${ext}`)
        if (!insideRoot(root, file)) return null
        let stat: Stats
        try {
          stat = await statPath(file)
        } catch {
          fileCache.delete(file)
          continue // Not this extension; try the next configured one.
        }
        if (!stat.isFile()) continue
        // Outside the try: a file that exists but fails to parse is an error, not a missing entry.
        return await readEntry(file, slug, `${stat.mtimeMs}:${stat.size}`)
      }
      return null
    },
  }
}
