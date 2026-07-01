/**
 * Local-filesystem {@link StorageAdapter} for long-running servers (Bun/Node/Deno). Keys map to paths
 * under `root`; `assertSafeKey` plus a resolved-path containment check keep writes inside `root` (no
 * traversal). Bytes-only: `contentType` is inferred from the key's extension on read, and custom metadata
 * is NOT persisted — use `MemoryStorage`/`R2Storage` (or your own adapter) if you need metadata round-tripped.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, posix, resolve, sep } from "node:path"
import { assertSafeKey, StorageKeyError } from "./key.ts"
import {
  type ListOptions,
  type PutOptions,
  type StorageAdapter,
  type StorageData,
  type StorageObject,
  toBytes,
} from "./types.ts"

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  json: "application/json",
  txt: "text/plain",
  csv: "text/csv",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  zip: "application/zip",
}

function inferContentType(key: string): string | undefined {
  const ext = key.slice(key.lastIndexOf(".") + 1).toLowerCase()
  return CONTENT_TYPES[ext]
}

export class FileStorage implements StorageAdapter {
  private readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  /** Resolve `key` to an absolute path, asserting it stays inside `root` (defense-in-depth on top of `assertSafeKey`). */
  private pathFor(key: string): string {
    assertSafeKey(key)
    const full = resolve(this.root, key)
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new StorageKeyError(`storage key ${JSON.stringify(key)} escapes the storage root`)
    }
    return full
  }

  async put(key: string, data: StorageData, _options: PutOptions = {}): Promise<void> {
    const path = this.pathFor(key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, toBytes(data))
  }

  async get(key: string): Promise<StorageObject | null> {
    const path = this.pathFor(key)
    let body: Uint8Array
    try {
      body = new Uint8Array(await readFile(path))
    } catch {
      return null // ENOENT (or unreadable) → treated as missing
    }
    const contentType = inferContentType(key)
    return contentType === undefined
      ? { body, size: body.byteLength }
      : { body, size: body.byteLength, contentType }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true })
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key))
      return true
    } catch {
      return false
    }
  }

  async list(options: ListOptions = {}): Promise<string[]> {
    const keys: string[] = []
    await this.walk(this.root, "", keys)
    let out = keys.sort()
    if (options.prefix !== undefined)
      out = out.filter((k) => k.startsWith(options.prefix as string))
    if (options.limit !== undefined) out = out.slice(0, options.limit)
    return out
  }

  private async walk(dir: string, prefix: string, out: string[]): Promise<void> {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return // missing root → empty listing
    }
    for (const name of names) {
      const full = join(dir, name)
      // POSIX-join the key segments so listed keys are portable regardless of the host separator.
      const key = prefix === "" ? name : posix.join(prefix, name)
      const info = await stat(full)
      if (info.isDirectory()) await this.walk(full, key, out)
      else if (info.isFile()) out.push(key)
    }
  }
}
