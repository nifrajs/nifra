/**
 * Filesystem-backed content collections — `defineCollection` reads a directory of Markdown files and
 * gives you a typed, validated API over them. Build/server-time (Bun/Node/Deno); for the edge, bake the
 * entries at build (the manifest approach `@nifrajs/web/fs` uses for routes) — tracked as a follow-up.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { resolve, sep } from "node:path"
import { type Entry, type InferSchema, parseEntry, type StandardSchemaV1 } from "./index.ts"

export interface CollectionConfig<S extends StandardSchemaV1> {
  /** Directory of content files, relative to the process cwd (or absolute). */
  readonly dir: string
  /** Standard Schema validating each file's frontmatter. */
  readonly schema: S
  /** File extensions to include (default `[".md", ".markdown"]`). */
  readonly extensions?: readonly string[]
}

/** A typed collection over a content directory. */
export interface Collection<Frontmatter> {
  /** Every entry in the directory (unordered — sort/filter in your loader). Throws if any file's
   * frontmatter is invalid. */
  all(): Promise<Array<Entry<Frontmatter>>>
  /** One entry by slug (filename without extension), or `null` if not found. */
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
  readonly signature: string
  readonly entries: Array<Entry<Frontmatter>>
}

/**
 * Define a content collection backed by a directory. `all()` discovers + parses every matching file;
 * `get(slug)` loads one. Frontmatter is validated against `schema`, so entries are fully typed and a
 * malformed file fails loudly. Reads the filesystem — use it at build time (SSG/prerender) or on a
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

  const readEntry = async (
    path: string,
    slug: string,
    stamp: string,
  ): Promise<Entry<InferSchema<S>>> => {
    const cached = fileCache.get(path)
    if (cached?.stamp === stamp) return cached.entry
    const entry = await parseEntry({
      raw: readFileSync(path, "utf8"),
      slug,
      schema: config.schema,
    })
    fileCache.set(path, { stamp, entry })
    return entry
  }

  const listFiles = (): FileRecord[] =>
    readdirSync(root)
      .filter(matches)
      .sort()
      .map((file) => {
        const path = resolve(root, file)
        const stat = statSync(path)
        return { file, path, stamp: `${stat.mtimeMs}:${stat.size}` }
      })

  return {
    async all() {
      const files = listFiles()
      const signature = files.map((file) => `${file.file}\0${file.stamp}`).join("\0")
      if (collectionCache?.signature === signature) return [...collectionCache.entries]

      const entries = await Promise.all(
        files.map((file) => readEntry(file.path, slugOf(file.file), file.stamp)),
      )
      collectionCache = {
        signature,
        entries,
      }
      return [...entries]
    },
    async get(slug) {
      if (!isSafeSlug(slug)) return null

      for (const ext of extensions) {
        const file = resolve(root, `${slug}${ext}`)
        if (!insideRoot(root, file)) return null
        try {
          const stat = statSync(file)
          if (!stat.isFile()) continue
          return await readEntry(file, slug, `${stat.mtimeMs}:${stat.size}`)
        } catch {
          // Not this extension or unreadable; try the next configured extension.
        }
      }
      return null
    },
  }
}
