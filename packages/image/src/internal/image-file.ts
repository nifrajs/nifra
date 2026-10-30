import * as fs from "node:fs"
import { join } from "node:path"
import type { ImageBuildAsset } from "../build.ts"

const invalid = () => new Error("[nifra/image] invalid cached image asset")

/** Publish through an exclusively opened descriptor; never overwrite a cached name or follow a link. */
export function cacheImageAsset(cache: string, asset: ImageBuildAsset): void {
  if (!/^_images\/[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(asset.fileName)) throw invalid()
  fs.mkdirSync(cache, { recursive: true })
  const root = fs.realpathSync(cache)
  const directory = join(root, "_images")
  fs.mkdirSync(directory, { recursive: true })
  if (!fs.lstatSync(directory).isDirectory()) throw invalid()
  const path = join(root, asset.fileName)
  // Match the kernel-level any-component protection used by the source-file opener on Darwin.
  const noFollow = process.platform === "darwin" ? 0x20000000 : fs.constants.O_NOFOLLOW
  let fd: number
  let created = false
  try {
    fd = fs.openSync(
      path,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow,
      0o644,
    )
    created = true
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | noFollow)
  }
  try {
    const opened = fs.fstatSync(fd, { bigint: true })
    const named = fs.lstatSync(path, { bigint: true })
    if (
      !opened.isFile() ||
      !named.isFile() ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino ||
      fs.realpathSync(path) !== path
    )
      throw invalid()
    if (process.platform === "linux" && fs.readlinkSync(`/proc/self/fd/${fd}`) !== path)
      throw invalid()
    if (created) {
      fs.writeFileSync(fd, asset.source)
      return
    }
    if (opened.size !== BigInt(asset.source.byteLength)) throw invalid()
    // A file growing after stat cannot make an unbounded read or an oversized allocation.
    const bytes = new Uint8Array(asset.source.byteLength + 1)
    let offset = 0
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, null)
      if (read === 0) break
      offset += read
    }
    if (
      offset !== asset.source.byteLength ||
      !Buffer.from(bytes.buffer, bytes.byteOffset, offset).equals(asset.source)
    )
      throw invalid()
  } finally {
    fs.closeSync(fd)
  }
}
