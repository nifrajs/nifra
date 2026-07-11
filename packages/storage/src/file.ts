/**
 * Local-filesystem {@link StorageAdapter} for long-running servers (Bun/Node/Deno). Keys map to paths
 * under `root`; `assertSafeKey` plus a resolved-path containment check keep writes inside `root` (no
 * traversal). Explicit content type and custom metadata are persisted in an adjacent sidecar tree;
 * objects created before sidecar support still infer content type from their extension.
 */
import { constants } from "node:fs"
import { lstat, mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises"
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
  private readonly metadataRoot: string

  constructor(root: string) {
    this.root = resolve(root)
    // Keep bookkeeping outside the object tree so every otherwise-safe key remains usable, including
    // `.nifra-metadata/*`, and list() never needs a reserved-prefix exception.
    this.metadataRoot = `${this.root}.nifra-metadata`
  }

  private metadataPathFor(key: string): string {
    assertSafeKey(key)
    const full = resolve(this.metadataRoot, `${key}.json`)
    if (!full.startsWith(this.metadataRoot + sep)) {
      throw new StorageKeyError(
        `storage metadata key ${JSON.stringify(key)} escapes the storage root`,
      )
    }
    return full
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

  private symlinkError(key: string): StorageKeyError {
    return new StorageKeyError(
      `storage key ${JSON.stringify(key)} crosses a symbolic link beneath the storage root`,
    )
  }

  /** Reject existing symbolic links below `base`; missing suffixes are safe for later creation. */
  private async assertNoSymlinkPath(base: string, path: string, key: string): Promise<void> {
    try {
      if ((await lstat(base)).isSymbolicLink()) throw this.symlinkError(key)
    } catch (error) {
      if (error instanceof StorageKeyError) throw error
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    const suffix = path.slice(base.length + sep.length)
    let current = base
    for (const segment of suffix.split(sep)) {
      current = join(current, segment)
      try {
        if ((await lstat(current)).isSymbolicLink()) throw this.symlinkError(key)
      } catch (error) {
        if (error instanceof StorageKeyError) throw error
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return
        throw error
      }
    }
  }

  /** Create parents, re-check them, and refuse a final-component symlink at open time. */
  private async writeContained(
    base: string,
    path: string,
    key: string,
    data: Uint8Array | string,
  ): Promise<void> {
    await this.assertNoSymlinkPath(base, path, key)
    await mkdir(dirname(path), { recursive: true })
    await this.assertNoSymlinkPath(base, path, key)
    try {
      const handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o666,
      )
      try {
        await handle.writeFile(data)
      } finally {
        await handle.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw this.symlinkError(key)
      throw error
    }
  }

  async put(key: string, data: StorageData, options: PutOptions = {}): Promise<void> {
    const path = this.pathFor(key)
    await this.writeContained(this.root, path, key, toBytes(data))
    const metadataPath = this.metadataPathFor(key)
    if (options.contentType !== undefined || options.metadata !== undefined) {
      await this.writeContained(
        this.metadataRoot,
        metadataPath,
        key,
        JSON.stringify({
          ...(options.contentType !== undefined ? { contentType: options.contentType } : {}),
          ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
        }),
      )
    } else {
      await this.assertNoSymlinkPath(this.metadataRoot, metadataPath, key)
      await rm(metadataPath, { force: true })
    }
  }

  async get(key: string): Promise<StorageObject | null> {
    const path = this.pathFor(key)
    await this.assertNoSymlinkPath(this.root, path, key)
    let body: Uint8Array
    try {
      body = new Uint8Array(await readFile(path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
    let stored: { contentType?: string; metadata?: Readonly<Record<string, string>> } = {}
    try {
      const metadataPath = this.metadataPathFor(key)
      await this.assertNoSymlinkPath(this.metadataRoot, metadataPath, key)
      stored = JSON.parse(await readFile(metadataPath, "utf8")) as typeof stored
    } catch (error) {
      if (error instanceof StorageKeyError) throw error
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error
      }
      // Objects created before sidecar support still infer a useful MIME type from their extension.
    }
    const contentType = stored.contentType ?? inferContentType(key)
    return {
      body,
      size: body.byteLength,
      ...(contentType !== undefined ? { contentType } : {}),
      ...(stored.metadata !== undefined ? { metadata: stored.metadata } : {}),
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key)
    const metadataPath = this.metadataPathFor(key)
    await Promise.all([
      this.assertNoSymlinkPath(this.root, path, key),
      this.assertNoSymlinkPath(this.metadataRoot, metadataPath, key),
    ])
    await Promise.all([rm(path, { force: true }), rm(metadataPath, { force: true })])
  }

  async exists(key: string): Promise<boolean> {
    const path = this.pathFor(key)
    await this.assertNoSymlinkPath(this.root, path, key)
    try {
      await stat(path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
      throw error
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
      const info = await lstat(full)
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) await this.walk(full, key, out)
      else if (info.isFile()) out.push(key)
    }
  }
}
