import { randomBytes } from "node:crypto"
import * as fs from "node:fs"
import { type FileHandle, lstat, open, readlink, realpath } from "node:fs/promises"
import { join } from "node:path"
import type { ImageBuildAsset } from "../build.ts"

// Mirrors packages/web/src/internal/image-assets.ts: @nifrajs/web cannot depend on this package,
// so the descriptor-pinned publication exists in both. Change them together.

const invalid = (detail = ""): Error =>
  new Error(`[nifra/image] invalid cached image asset${detail}`)
const damaged = (path: string): Error =>
  invalid(`: ${path} does not match its content hash; delete it to rebuild it`)

// Darwin's O_NOFOLLOW_ANY refuses a link in any path component, not only the last.
const NO_FOLLOW = process.platform === "darwin" ? 0x20000000 : fs.constants.O_NOFOLLOW
const isCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code

/** The held descriptor must still be the regular file the path names, with no link on the way. */
function pinned(descriptor: number, path: string): bigint {
  const held = fs.fstatSync(descriptor, { bigint: true })
  const named = fs.lstatSync(path, { bigint: true })
  if (
    !held.isFile() ||
    !named.isFile() ||
    held.dev !== named.dev ||
    held.ino !== named.ino ||
    fs.realpathSync(path) !== path
  )
    throw invalid()
  if (process.platform === "linux" && fs.readlinkSync(`/proc/self/fd/${descriptor}`) !== path)
    throw invalid()
  return held.size
}

function openExisting(path: string): number | undefined {
  try {
    return fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | NO_FOLLOW)
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined
    throw error
  }
}

/** Compare an existing file with the expected bytes through its held descriptor, reading at most one
 * byte more than expected so a file that grew after stat() cannot cause an unbounded read. */
function verifyExisting(descriptor: number, path: string, source: Uint8Array): void {
  try {
    const size = pinned(descriptor, path)
    if (size !== BigInt(source.byteLength)) throw damaged(path)
    const bytes = new Uint8Array(source.byteLength + 1)
    let offset = 0
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, null)
      if (read === 0) break
      offset += read
    }
    if (
      offset !== source.byteLength ||
      !Buffer.from(bytes.buffer, bytes.byteOffset, offset).equals(source)
    )
      throw damaged(path)
  } finally {
    fs.closeSync(descriptor)
  }
}

/** Write a temporary file and hard-link it to its final name, so the name only ever appears complete
 * and never replaces an existing entry. Returns false when another writer owns the name already. */
function publishFresh(directory: string, path: string, source: Uint8Array): boolean {
  const temporary = join(directory, `.${randomBytes(8).toString("hex")}.tmp`)
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NO_FOLLOW,
    0o644,
  )
  try {
    pinned(descriptor, temporary)
    fs.writeFileSync(descriptor, source)
    fs.fsyncSync(descriptor)
    try {
      fs.linkSync(temporary, path)
      return true
    } catch (error) {
      if (isCode(error, "EEXIST")) return false
      throw error
    }
  } finally {
    fs.closeSync(descriptor)
    fs.rmSync(temporary, { force: true })
  }
}

/** Publish through descriptors; never overwrite a cached name or follow a link. */
export function cacheImageAsset(cache: string, asset: ImageBuildAsset): void {
  if (!/^_images\/[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(asset.fileName)) throw invalid()
  fs.mkdirSync(cache, { recursive: true })
  const root = fs.realpathSync(cache)
  const directory = join(root, "_images")
  fs.mkdirSync(directory, { recursive: true })
  if (!fs.lstatSync(directory).isDirectory()) throw invalid()
  const path = join(root, asset.fileName)
  const existing = openExisting(path)
  if (existing !== undefined) {
    verifyExisting(existing, path, asset.source)
    return
  }
  if (publishFresh(directory, path, asset.source)) return
  // Another process published the same content-addressed name first: hold it to the same standard.
  const raced = openExisting(path)
  if (raced === undefined) throw invalid()
  verifyExisting(raced, path, asset.source)
}

/** Open a source image that `path` (already canonical) names, refusing a link or any other entry
 * swapped in since the root check. Never blocks on a FIFO. */
export async function openPinned(path: string): Promise<FileHandle> {
  const handle = await open(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | NO_FOLLOW)
  try {
    const held = await handle.stat({ bigint: true })
    if (!held.isFile()) throw new Error("[nifra/image] image source must be a regular file")
    const named = await lstat(path, { bigint: true })
    if (
      !named.isFile() ||
      named.dev !== held.dev ||
      named.ino !== held.ino ||
      (await realpath(path)) !== path ||
      (process.platform === "linux" && (await readlink(`/proc/self/fd/${handle.fd}`)) !== path)
    )
      throw new Error("[nifra/image] image source changed while it was being opened")
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}
