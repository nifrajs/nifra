/** Build-only structural image-plugin hook; @nifrajs/web does not depend on an image codec/package. */
import { createHash, randomBytes } from "node:crypto"
import {
  closeSync,
  constants as FS,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { codeUnitOrder } from "./code-unit-order.ts"

interface ImageAsset {
  readonly fileName: string
  readonly source: Uint8Array
}
const assetName = /^_images\/([a-f0-9]{64})\.(png|jpg|webp|gif)$/
const invalid = (): Error =>
  new Error("[nifra/web] image plugin returned an invalid or conflicting static asset")
const damaged = (path: string): Error =>
  new Error(
    `[nifra/web] invalid existing image output ${path}: it does not match its content hash; delete it and rebuild`,
  )

/** True for a URL the image plugins emitted: those are media, not code, and stay out of size reports. */
export const isImageAssetUrl = (url: string): boolean =>
  /\/_images\/[a-f0-9]{64}\.(?:png|jpg|webp|gif)$/.test(url)

const withTrailingSlash = (publicPath: string): string =>
  publicPath.endsWith("/") ? publicPath : `${publicPath}/`

/** With `publicPath`, a plugin that declares another prefix is refused: its imports would 404. */
export function pluginImageAssets(
  plugins: readonly unknown[] = [],
  publicPath?: string,
): readonly ImageAsset[] {
  const files = new Map<string, ImageAsset>()
  const expected = publicPath === undefined ? undefined : withTrailingSlash(publicPath)
  const visit = (plugin: unknown): void => {
    if (Array.isArray(plugin)) {
      for (const child of plugin) visit(child)
      return
    }
    if (typeof plugin !== "object" || plugin === null) return
    const hook: unknown = Reflect.get(plugin, "nifraStaticAssets")
    if (typeof hook !== "function") return
    const declared: unknown = Reflect.get(plugin, "nifraPublicPath")
    if (expected !== undefined && declared !== undefined && declared !== expected) {
      throw new Error(
        `[nifra/web] an image plugin is configured for publicPath ${JSON.stringify(declared)} but the build uses ${JSON.stringify(expected)}; set the same publicPath on both`,
      )
    }
    const assets: unknown = Reflect.apply(hook, plugin, [])
    if (!Array.isArray(assets)) throw invalid()
    for (const asset of assets) {
      if (typeof asset !== "object" || asset === null) throw invalid()
      const fileName: unknown = Reflect.get(asset, "fileName")
      const source: unknown = Reflect.get(asset, "source")
      if (
        typeof fileName !== "string" ||
        !assetName.test(fileName) ||
        !(source instanceof Uint8Array)
      )
        throw invalid()
      const prior = files.get(fileName)
      // The same plugin listed for both halves of a build yields the same buffers.
      if (
        prior !== undefined &&
        prior.source !== source &&
        !Buffer.from(prior.source.buffer, prior.source.byteOffset, prior.source.byteLength).equals(
          source,
        )
      )
        throw invalid()
      files.set(fileName, { fileName, source })
    }
  }
  for (const plugin of plugins) visit(plugin)
  return [...files.values()].sort((a, b) => codeUnitOrder(a.fileName, b.fileName))
}

// Mirrors packages/image/src/internal/image-file.ts: this package cannot depend on @nifrajs/image,
// so the descriptor-pinned publication exists in both. Change them together.
// Darwin's O_NOFOLLOW_ANY refuses a link in any path component, not only the last.
const NO_FOLLOW = process.platform === "darwin" ? 0x20000000 : FS.O_NOFOLLOW
const isCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code

/** The held descriptor must still be the regular file the path names, with no link on the way. */
function pinned(descriptor: number, path: string): bigint {
  const held = fstatSync(descriptor, { bigint: true })
  const current = lstatSync(path, { bigint: true })
  if (
    !held.isFile() ||
    !current.isFile() ||
    held.ino !== current.ino ||
    held.dev !== current.dev ||
    realpathSync(path) !== path
  )
    throw invalid()
  if (process.platform === "linux" && readlinkSync(`/proc/self/fd/${descriptor}`) !== path)
    throw invalid()
  return held.size
}

function openExisting(path: string): number | undefined {
  try {
    return openSync(path, FS.O_RDONLY | FS.O_NONBLOCK | NO_FOLLOW)
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined
    throw error
  }
}

function verifyExisting(descriptor: number, path: string, file: ImageAsset): void {
  try {
    if (pinned(descriptor, path) !== BigInt(file.source.byteLength)) throw damaged(path)
    const contents = new Uint8Array(file.source.byteLength + 1)
    let total = 0
    let read: number
    do {
      read = readSync(descriptor, contents, total, contents.length - total, null)
      total += read
    } while (read > 0 && total < contents.length)
    if (
      total !== file.source.byteLength ||
      createHash("sha256").update(contents.subarray(0, total)).digest("hex") !==
        assetName.exec(file.fileName)?.[1]
    )
      throw damaged(path)
  } finally {
    closeSync(descriptor)
  }
}

/** Write a temporary file and hard-link it to its final name, so the name only ever appears complete
 * and never replaces an existing entry. Returns false when another writer owns the name already. */
function publishFresh(directory: string, path: string, file: ImageAsset): boolean {
  const temporary = join(directory, `.${randomBytes(8).toString("hex")}.tmp`)
  const descriptor = openSync(temporary, FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY | NO_FOLLOW, 0o644)
  try {
    pinned(descriptor, temporary)
    writeFileSync(descriptor, file.source)
    fsyncSync(descriptor)
    try {
      linkSync(temporary, path)
      return true
    } catch (error) {
      if (isCode(error, "EEXIST")) return false
      throw error
    }
  } finally {
    closeSync(descriptor)
    rmSync(temporary, { force: true })
  }
}

function writeAssetFile(directory: string, path: string, file: ImageAsset): void {
  const existing = openExisting(path)
  if (existing !== undefined) {
    verifyExisting(existing, path, file)
    return
  }
  if (publishFresh(directory, path, file)) return
  const raced = openExisting(path)
  if (raced === undefined) throw invalid()
  verifyExisting(raced, path, file)
}

/**
 * Validate every output before writing, and never follow an existing output symlink. `emitted` names
 * files an earlier call of the same build already validated and wrote; they are not touched again.
 */
export function emitPluginImages(
  plugins: readonly unknown[],
  outDir: string,
  publicPath = "/assets/",
  emitted?: Set<string>,
): readonly string[] {
  const files = pluginImageAssets(plugins, publicPath)
  const pending = files.filter((file) => emitted?.has(file.fileName) !== true)
  for (const file of pending) {
    const expected = assetName.exec(file.fileName)?.[1]
    if (createHash("sha256").update(file.source).digest("hex") !== expected) throw invalid()
  }
  if (pending.length > 0) {
    mkdirSync(outDir, { recursive: true })
    const root = realpathSync(outDir)
    const dir = join(root, "_images")
    mkdirSync(dir, { recursive: true })
    if (!lstatSync(dir).isDirectory()) throw invalid()
    for (const file of pending) {
      writeAssetFile(dir, join(root, file.fileName), file)
      emitted?.add(file.fileName)
    }
  }
  const prefix = withTrailingSlash(publicPath)
  return files.map((file) => `${prefix}${file.fileName}`)
}

/** Native Bun dev serves the same in-memory hashed bytes as the Vite image middleware. */
export function pluginImageResponse(
  plugins: readonly unknown[],
  request: Request,
): Response | undefined {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined
  const path = new URL(request.url).pathname
  if (!path.startsWith("/assets/_images/")) return undefined
  const asset = pluginImageAssets(plugins).find((file) => `/assets/${file.fileName}` === path)
  if (asset === undefined) return undefined
  const extension = asset.fileName.slice(asset.fileName.lastIndexOf(".") + 1)
  return new Response(request.method === "HEAD" ? null : asset.source.slice().buffer, {
    headers: {
      "content-type": `image/${extension === "jpg" ? "jpeg" : extension}`,
      "content-length": String(asset.source.byteLength),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  })
}
