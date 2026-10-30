/** Node-compatible, build-only image processing. Never imported by the browser-safe entry. */
import { createHash } from "node:crypto"
import { open, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import type { ImageBackend, OutputFormat } from "./backend.ts"
import { imageBuildMetadata } from "./build-metadata.ts"
import { imageDimensions } from "./dimensions.ts"
import type { StaticImageData, StaticImageVariant } from "./static.ts"

export interface ImageBuildOptions {
  /** Only local files beneath this directory may be imported (symlinks are resolved). */
  readonly root?: string
  /** Match the client build's publicPath. Default `/assets/`. */
  readonly publicPath?: string
  /** Omit for codec-free metadata imports. Requested widths are clamped to the source width. */
  readonly widths?: readonly number[]
  /** Required when widths are requested; inject sharp, Bun.Image, or a WASM backend explicitly. */
  readonly backend?: ImageBackend
  readonly format?: OutputFormat
  readonly quality?: number
  readonly maxSourceBytes?: number
  readonly maxSourcePixels?: number
}

/** The structural asset hook consumed by Nifra's build pipelines. Paths are relative to /assets/. */
export interface ImageBuildAsset {
  readonly fileName: string
  readonly source: Uint8Array
}

export interface ImageAssets {
  /** Start a new module graph without retaining images from an earlier build. */
  clear(): void
  load(file: string): Promise<StaticImageData>
  assets(): readonly ImageBuildAsset[]
}

const fail = (message: string): Error => new Error(`[nifra/image] ${message}`)
const positiveInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw fail(`${name} must be a positive safe integer`)
  return value
}
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

/** Read at most the configured cap, including when a source grows after stat(). */
async function boundedRead(file: string, limit: number): Promise<Uint8Array> {
  const handle = await open(file, "r")
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw fail("image source must be a regular file")
    if (stat.size > limit) throw fail("image source exceeds maxSourceBytes")
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const chunk = new Uint8Array(Math.min(64 * 1024, limit - total + 1))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > limit) throw fail("image source exceeds maxSourceBytes")
      chunks.push(chunk.subarray(0, bytesRead))
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return bytes
  } finally {
    await handle.close()
  }
}

interface PreparedImage {
  readonly data: StaticImageData
  readonly files: readonly ImageBuildAsset[]
}

/** Shared builder for client/SSR imports. Processing results depend on bytes, never absolute paths. */
export function createImageAssets(options: ImageBuildOptions = {}): ImageAssets {
  const root = resolve(options.root ?? process.cwd())
  const publicPath = options.publicPath ?? "/assets/"
  if (
    !publicPath.startsWith("/") ||
    publicPath.startsWith("//") ||
    /[\\?#\s]/.test(publicPath) ||
    publicPath.split("/").some((part) => part === "." || part === ".." || part.includes("%"))
  ) {
    throw fail("publicPath must be a root-relative asset prefix without query, hash or traversal")
  }
  const prefix = publicPath.endsWith("/") ? publicPath : `${publicPath}/`
  const maxBytes = positiveInteger(options.maxSourceBytes ?? 16 * 1024 * 1024, "maxSourceBytes")
  const maxPixels = positiveInteger(options.maxSourcePixels ?? 40_000_000, "maxSourcePixels")
  const quality = positiveInteger(options.quality ?? 80, "quality")
  if (quality > 100) throw fail("quality must be between 1 and 100")
  const format = options.format ?? "webp"
  if (!["webp", "jpeg", "png"].includes(format)) throw fail("format must be webp, jpeg or png")
  const requested = [...new Set(options.widths ?? [])].sort((a, b) => a - b)
  if (requested.length > 32) throw fail("at most 32 responsive widths may be requested")
  for (const width of requested) {
    positiveInteger(width, "responsive width")
    if (width > 8192) throw fail("responsive widths must not exceed 8192")
  }
  if (requested.length > 0 && options.backend === undefined)
    throw fail("responsive widths require an explicit image backend")
  const entries = new Map<
    string,
    { hash: string; result: Promise<PreparedImage>; files?: readonly ImageBuildAsset[] }
  >()

  const prepare = async (bytes: Uint8Array): Promise<PreparedImage> => {
    const { info, animated } = imageBuildMetadata(bytes)
    if (
      info === null ||
      !Number.isSafeInteger(info.width) ||
      !Number.isSafeInteger(info.height) ||
      info.width <= 0 ||
      info.height <= 0
    )
      throw fail("image source must be a supported PNG, JPEG, GIF or WebP with positive dimensions")
    if (info.width > maxPixels / info.height) throw fail("image source exceeds maxSourcePixels")
    const files: ImageBuildAsset[] = []
    const add = (source: Uint8Array, extension: string): string => {
      const fileName = `_images/${digest(source)}.${extension === "jpeg" ? "jpg" : extension}`
      files.push({ fileName, source })
      return `${prefix}${fileName}`
    }
    const src = add(bytes, info.format)
    const variants: StaticImageVariant[] = []
    const widths = [...new Set(requested.map((width) => Math.min(width, info.width)))]
    if (widths.length > 0) {
      if (animated)
        throw fail("animated image variants are not supported; use a metadata-only import")
      const backend = options.backend
      if (backend === undefined) throw fail("responsive widths require an explicit image backend")
      for (const width of widths) {
        const result = await backend.transform({ bytes, width, quality, format })
        if (
          !(result.bytes instanceof Uint8Array) ||
          result.bytes.length === 0 ||
          result.bytes.length > maxBytes ||
          result.format !== format
        )
          throw fail("image backend returned invalid or oversized output")
        const output = imageDimensions(result.bytes)
        if (
          output === null ||
          output.width !== width ||
          output.height <= 0 ||
          output.format !== format ||
          output.width > maxPixels / output.height
        )
          throw fail("image backend returned inconsistent variant dimensions or format")
        variants.push({
          src: add(result.bytes, format),
          width: output.width,
          height: output.height,
        })
      }
    }
    return {
      data: {
        src,
        width: info.width,
        height: info.height,
        ...(variants.length > 0 ? { variants } : {}),
      },
      files,
    }
  }

  return {
    clear() {
      entries.clear()
    },
    async load(file) {
      const canonicalRoot = await realpath(root)
      const path = await realpath(resolve(root, file))
      const rel = relative(canonicalRoot, path)
      if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        throw fail("image source escapes its configured root")
      const bytes = await boundedRead(path, maxBytes)
      const hash = digest(bytes)
      let entry = entries.get(path)
      if (entry === undefined || entry.hash !== hash) {
        entry = { hash, result: prepare(bytes) }
        entries.set(path, entry)
      }
      const result = await entry.result
      entry.files = result.files
      return result.data
    },
    assets() {
      const files = new Map<string, ImageBuildAsset>()
      for (const entry of entries.values())
        for (const file of entry.files ?? []) files.set(file.fileName, file)
      return [...files.values()].sort((a, b) =>
        a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0,
      )
    },
  }
}
