/**
 * Local-filesystem {@link StorageAdapter} for long-running servers (Bun/Node/Deno). Keys map to paths
 * under `root`; `assertSafeKey` plus a resolved-path containment check keep writes inside `root` (no
 * traversal). Explicit content type and custom metadata are persisted in an adjacent sidecar tree;
 * objects created before sidecar support still infer content type from their extension.
 */
import { constants } from "node:fs"
import { type FileHandle, lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises"
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

  private assertTrustedDirectory(info: Awaited<ReturnType<typeof lstat>>, key: string): void {
    // Node exposes POSIX mode bits on Bun/Node/Deno Unix runtimes. A group/world-writable ancestor lets
    // another local principal swap path components between otherwise-correct checks; fail closed so
    // descriptor validation only has to defend against ordinary filesystem races within one principal.
    if (process.platform !== "win32" && info.isDirectory() && (Number(info.mode) & 0o022) !== 0) {
      throw new StorageKeyError(
        `storage key ${JSON.stringify(key)} crosses a group/world-writable directory`,
      )
    }
  }

  /** Reject existing symbolic links below `base`; missing suffixes are safe for later creation. */
  private async assertNoSymlinkPath(base: string, path: string, key: string): Promise<void> {
    try {
      const info = await lstat(base)
      if (info.isSymbolicLink()) throw this.symlinkError(key)
      this.assertTrustedDirectory(info, key)
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
        const info = await lstat(current)
        if (info.isSymbolicLink()) throw this.symlinkError(key)
        this.assertTrustedDirectory(info, key)
      } catch (error) {
        if (error instanceof StorageKeyError) throw error
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return
        throw error
      }
    }
  }

  /**
   * Open an existing file without following its final component, then prove the descriptor is the file
   * still reachable through a symlink-free path below the same root inode. Reads use the descriptor,
   * not the pathname checked earlier, closing their check/open race.
   */
  private async openContained(base: string, path: string, key: string): Promise<FileHandle | null> {
    await this.assertNoSymlinkPath(base, path, key)
    let baseBefore: Awaited<ReturnType<typeof lstat>>
    try {
      baseBefore = await lstat(base)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }

    let handle: FileHandle
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT") return null
      if (code === "ELOOP") throw this.symlinkError(key)
      throw error
    }

    try {
      await this.assertOpenedContained(base, path, key, handle, baseBefore)
      return handle
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  private async assertOpenedContained(
    base: string,
    path: string,
    key: string,
    handle: FileHandle,
    baseBefore: Awaited<ReturnType<typeof lstat>>,
  ): Promise<void> {
    await this.assertNoSymlinkPath(base, path, key)
    try {
      const [opened, current, baseAfter, resolvedBase, resolvedPath] = await Promise.all([
        handle.stat(),
        lstat(path),
        lstat(base),
        realpath(base),
        realpath(path),
      ])
      const baseChanged = baseBefore.dev !== baseAfter.dev || baseBefore.ino !== baseAfter.ino
      const targetChanged =
        current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino
      const escaped = resolvedPath !== resolvedBase && !resolvedPath.startsWith(resolvedBase + sep)
      if (baseChanged || targetChanged || escaped) throw this.symlinkError(key)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw this.symlinkError(key)
      throw error
    }
  }

  /**
   * Create parents and open without truncating. The opened inode is validated against the current,
   * fully resolved path before any caller data is written, closing the check/open symlink race.
   */
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
      const baseBefore = await lstat(base)
      const handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
        0o666,
      )
      try {
        // Do not truncate until the descriptor is proven to be the same file currently reachable
        // through a symlink-free path beneath the same storage-root directory.
        await this.assertNoSymlinkPath(base, path, key)
        const [opened, current, baseAfter, resolvedBase, resolvedPath] = await Promise.all([
          handle.stat(),
          lstat(path),
          lstat(base),
          realpath(base),
          realpath(path),
        ])
        const baseChanged = baseBefore.dev !== baseAfter.dev || baseBefore.ino !== baseAfter.ino
        const targetChanged =
          current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino
        const escaped =
          resolvedPath !== resolvedBase && !resolvedPath.startsWith(resolvedBase + sep)
        if (baseChanged || targetChanged || escaped) throw this.symlinkError(key)

        await handle.truncate(0)
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
      await this.removeContained(this.metadataRoot, metadataPath, key)
    }
  }

  async get(key: string): Promise<StorageObject | null> {
    const path = this.pathFor(key)
    const bodyHandle = await this.openContained(this.root, path, key)
    if (bodyHandle === null) return null
    let body: Uint8Array
    try {
      body = new Uint8Array(await bodyHandle.readFile())
    } finally {
      await bodyHandle.close()
    }
    let stored: { contentType?: string; metadata?: Readonly<Record<string, string>> } = {}
    try {
      const metadataPath = this.metadataPathFor(key)
      const metadataHandle = await this.openContained(this.metadataRoot, metadataPath, key)
      if (metadataHandle !== null) {
        try {
          stored = JSON.parse(await metadataHandle.readFile({ encoding: "utf8" })) as typeof stored
        } finally {
          await metadataHandle.close()
        }
      }
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
      this.removeContained(this.root, path, key),
      this.removeContained(this.metadataRoot, metadataPath, key),
    ])
  }

  async exists(key: string): Promise<boolean> {
    const path = this.pathFor(key)
    const handle = await this.openContained(this.root, path, key)
    if (handle === null) return false
    try {
      return true
    } finally {
      await handle.close()
    }
  }

  /** Revalidate an opened inode immediately before unlinking its pathname. */
  private async removeContained(base: string, path: string, key: string): Promise<void> {
    const handle = await this.openContained(base, path, key)
    if (handle === null) return
    try {
      const baseBefore = await lstat(base)
      await this.assertOpenedContained(base, path, key, handle, baseBefore)
      await rm(path, { force: true })
    } finally {
      await handle.close()
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
