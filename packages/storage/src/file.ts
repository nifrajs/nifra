/**
 * Local-filesystem {@link StorageAdapter} for long-running servers (Bun/Node/Deno). Keys map to paths
 * under `root`; `assertSafeKey` plus a resolved-path containment check keep writes inside `root` (no
 * traversal). Explicit content type and custom metadata are persisted in a sidecar tree beside the
 * root that mirrors the object paths; sidecars written by earlier versions (`<key>.json` in
 * `<root>.nifra-metadata`) are still read, and objects with none infer content type from their extension.
 * Every write is staged beside the root and renamed into place, so a reader sees an object whole.
 */
import { constants } from "node:fs"
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises"
import { basename, dirname, join, posix, resolve, sep } from "node:path"
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

interface StoredMetadata {
  readonly contentType?: string
  readonly metadata?: Readonly<Record<string, string>>
}

const errorCode = (error: unknown): unknown =>
  error instanceof Error && "code" in error ? error.code : undefined

// ENOTDIR: a legacy `a.json` sidecar file sits where key `a.json/b`'s sidecar would need a directory.
const isMissing = (error: unknown): boolean => {
  const code = errorCode(error)
  return code === "ENOENT" || code === "ENOTDIR"
}

export class FileStorage implements StorageAdapter {
  private readonly root: string
  private readonly metadataRoot: string
  private readonly legacyMetadataRoot: string
  private readonly stagingRoot: string

  constructor(root: string) {
    this.root = resolve(root)
    // Keep bookkeeping outside the object tree so every otherwise-safe key remains usable, including
    // `.nifra-metadata/*`, and list() never needs a reserved-prefix exception. Sidecars mirror the
    // object paths exactly, so two keys clash there only where their objects would clash anyway.
    const state = `${this.root}.nifra-state`
    this.metadataRoot = join(state, "metadata")
    this.stagingRoot = join(state, "staging")
    this.legacyMetadataRoot = `${this.root}.nifra-metadata`
  }

  private metadataPathFor(key: string): string {
    return this.containedPath(this.metadataRoot, key, key)
  }

  /** `<key>.json`, where earlier versions kept a sidecar: `a.json` there is also key `a.json`'s parent. */
  private legacyMetadataPathFor(key: string): string {
    return this.containedPath(this.legacyMetadataRoot, `${key}.json`, key)
  }

  private containedPath(base: string, relative: string, key: string): string {
    assertSafeKey(key)
    const full = resolve(base, relative)
    if (!full.startsWith(base + sep)) {
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

  private assertTrustedDirectory(
    info: Awaited<ReturnType<typeof lstat>>,
    key: string,
    dir: string,
  ): void {
    // Node exposes POSIX mode bits on Bun/Node/Deno Unix runtimes. A group/world-writable ancestor lets
    // another local principal swap path components between otherwise-correct checks; fail closed so
    // descriptor validation only has to defend against ordinary filesystem races within one principal.
    if (process.platform === "win32" || !info.isDirectory()) return
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined
    const untrustedOwner = uid !== undefined && info.uid !== uid && info.uid !== 0
    if (untrustedOwner || (Number(info.mode) & 0o022) !== 0) {
      throw new StorageKeyError(
        `storage key ${JSON.stringify(key)} crosses an untrusted writable directory: ${dir} ${
          untrustedOwner
            ? "belongs to another user"
            : "is group- or world-writable (chmod go-w removes that)"
        }`,
      )
    }
  }

  /**
   * Prove that another local principal cannot rename any directory leading to `base` after validation.
   * A sticky shared parent (the ordinary `/tmp` case) is safe only while its child belongs to this uid.
   * Root-owned system directories are trusted; a directory owned by any other uid is not.
   */
  private async assertTrustedAncestorChain(base: string, key: string): Promise<void> {
    if (process.platform === "win32" || typeof process.getuid !== "function") return
    const uid = process.getuid()
    let current = await realpath(base)
    let child = await lstat(current)
    for (;;) {
      const parent = dirname(current)
      if (parent === current) return
      const info = await lstat(parent)
      const mode = Number(info.mode)
      const trustedOwner = info.uid === uid || info.uid === 0
      const writableByAnotherPrincipal = (mode & 0o022) !== 0
      const stickyProtectsChild = (mode & 0o1000) !== 0 && child.uid === uid
      if (!trustedOwner || (writableByAnotherPrincipal && !stickyProtectsChild)) {
        throw new StorageKeyError(
          `storage key ${JSON.stringify(key)} crosses an untrusted writable ancestor`,
        )
      }
      current = parent
      child = info
    }
  }

  /** Reject existing symbolic links below `base`; missing suffixes are safe for later creation. */
  private async assertNoSymlinkPath(base: string, path: string, key: string): Promise<void> {
    try {
      const info = await lstat(base)
      if (info.isSymbolicLink()) throw this.symlinkError(key)
      this.assertTrustedDirectory(info, key, base)
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
        this.assertTrustedDirectory(info, key, current)
      } catch (error) {
        if (error instanceof StorageKeyError) throw error
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return
        throw error
      }
    }
  }

  /** {@link openContained} for an object: a directory under the root is a key prefix, not an object. */
  private async openObject(base: string, path: string, key: string): Promise<FileHandle | null> {
    const handle = await this.openContained(base, path, key)
    if (handle === null || (await handle.stat()).isFile()) return handle
    await handle.close()
    return null
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
   * Write `data` whole or not at all: staged in a sibling directory, then renamed over `path`, so a
   * reader never sees a half-written object and a failed write leaves the previous one. The renamed
   * inode is then proven to be the staged one, reachable beneath the same root.
   */
  private async writeContained(
    base: string,
    path: string,
    key: string,
    data: Uint8Array | string,
  ): Promise<void> {
    await this.assertNoSymlinkPath(base, path, key)
    await mkdir(dirname(path), { recursive: true, mode: 0o755 })
    const staged = await this.stage(key, data)
    try {
      await this.assertNoSymlinkPath(base, path, key)
      const baseBefore = await lstat(base)
      try {
        await rename(staged.path, path)
      } catch (error) {
        // A root that is its own mount point cannot take a rename from beside it.
        if (errorCode(error) !== "EXDEV") throw error
        await this.writeInPlace(base, path, key, data)
        return
      }
      const [current, baseAfter, resolvedBase, resolvedPath] = await Promise.all([
        lstat(path),
        lstat(base),
        realpath(base),
        realpath(path),
      ])
      const baseChanged = baseBefore.dev !== baseAfter.dev || baseBefore.ino !== baseAfter.ino
      const targetChanged =
        current.isSymbolicLink() || staged.dev !== current.dev || staged.ino !== current.ino
      const escaped = resolvedPath !== resolvedBase && !resolvedPath.startsWith(resolvedBase + sep)
      if (baseChanged || targetChanged || escaped) throw this.symlinkError(key)
    } finally {
      // Gone already once the rename landed; this clears a staged file the write abandoned.
      await unlink(staged.path).catch(() => {})
    }
  }

  /** A new, exclusively created file in the staging directory holding `data`. */
  private async stage(
    key: string,
    data: Uint8Array | string,
  ): Promise<{ readonly path: string; readonly dev: number; readonly ino: number }> {
    await mkdir(this.stagingRoot, { recursive: true, mode: 0o755 })
    const path = join(this.stagingRoot, `${crypto.randomUUID()}.tmp`)
    await this.assertNoSymlinkPath(this.stagingRoot, path, key)
    let handle: FileHandle
    try {
      handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o666,
      )
    } catch (error) {
      if (errorCode(error) === "ELOOP") throw this.symlinkError(key)
      throw error
    }
    try {
      await handle.writeFile(data)
      const info = await handle.stat()
      return { path, dev: info.dev, ino: info.ino }
    } catch (error) {
      await unlink(path).catch(() => {})
      throw error
    } finally {
      await handle.close()
    }
  }

  /**
   * Create parents and open without truncating. The opened inode is validated against the current,
   * fully resolved path before any caller data is written, closing the check/open symlink race.
   */
  private async writeInPlace(
    base: string,
    path: string,
    key: string,
    data: Uint8Array | string,
  ): Promise<void> {
    await this.assertNoSymlinkPath(base, path, key)
    // 0o755 whatever the umask: a group-writable directory (umask 002) would fail the trust check above.
    await mkdir(dirname(path), { recursive: true, mode: 0o755 })
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
    await this.removeLegacyMetadata(key)
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
    const bodyHandle = await this.openObject(this.root, path, key)
    if (bodyHandle === null) return null
    let body: Uint8Array
    try {
      body = new Uint8Array(await bodyHandle.readFile())
    } finally {
      await bodyHandle.close()
    }
    const stored =
      (await this.readMetadata(this.metadataRoot, this.metadataPathFor(key), key)) ??
      (await this.readMetadata(this.legacyMetadataRoot, this.legacyMetadataPathFor(key), key)) ??
      {}
    // Objects with no sidecar still infer a useful MIME type from their extension.
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
      this.removeLegacyMetadata(key),
    ])
  }

  private async readMetadata(
    base: string,
    path: string,
    key: string,
  ): Promise<StoredMetadata | undefined> {
    try {
      const handle = await this.openObject(base, path, key)
      if (handle === null) return undefined
      try {
        return JSON.parse(await handle.readFile({ encoding: "utf8" })) as StoredMetadata
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (error instanceof StorageKeyError) throw error
      if (!isMissing(error) && !(error instanceof SyntaxError)) throw error
      return undefined
    }
  }

  private async removeLegacyMetadata(key: string): Promise<void> {
    try {
      await this.removeContained(this.legacyMetadataRoot, this.legacyMetadataPathFor(key), key)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }

  async exists(key: string): Promise<boolean> {
    const path = this.pathFor(key)
    const handle = await this.openObject(this.root, path, key)
    if (handle === null) return false
    try {
      return true
    } finally {
      await handle.close()
    }
  }

  /** Revalidate an opened inode immediately before unlinking its pathname. */
  private async removeContained(base: string, path: string, key: string): Promise<void> {
    const handle = await this.openObject(base, path, key)
    if (handle === null) return
    try {
      await this.assertTrustedAncestorChain(base, key)
      const baseBefore = await lstat(base)
      await this.assertOpenedContained(base, path, key, handle, baseBefore)
      if (process.platform === "linux") {
        // Node exposes no unlinkat(2), but Linux's procfs gives an equivalent descriptor-relative path.
        // Anchor the final lookup to an opened, validated parent so replacing an intermediate directory
        // cannot redirect deletion outside the storage root.
        const parentPath = dirname(path)
        const parentHandle = await this.openContained(base, parentPath, key)
        if (parentHandle === null) throw this.symlinkError(key)
        try {
          const anchoredPath = join("/proc/self/fd", String(parentHandle.fd), basename(path))
          const [opened, current] = await Promise.all([handle.stat(), lstat(anchoredPath)])
          if (
            current.isSymbolicLink() ||
            opened.dev !== current.dev ||
            opened.ino !== current.ino
          ) {
            throw this.symlinkError(key)
          }
          await unlink(anchoredPath)
        } finally {
          await parentHandle.close()
        }
      } else {
        // Other Node-compatible runtimes expose no descriptor-relative unlink. The verified ownership /
        // permission chain above removes the cross-principal swap capability before this pathname lookup.
        await unlink(path)
      }
    } finally {
      await handle.close()
    }
  }

  async list(options: ListOptions = {}): Promise<string[]> {
    const prefix = options.prefix ?? ""
    const limit = options.limit ?? Number.POSITIVE_INFINITY
    // Start below the directories the prefix already names, and stop once `limit` keys are found:
    // the walk visits entries in key order, so the first keys found are the first keys sorted.
    const slash = prefix.lastIndexOf("/")
    const dirKey = slash === -1 ? "" : prefix.slice(0, slash)
    const start = slash === -1 ? this.root : await this.listingDirectory(dirKey)
    const out: string[] = []
    if (start !== undefined && limit > 0)
      await this.walk(start, dirKey, prefix.slice(slash + 1), limit, out)
    return out
  }

  /** The directory for key prefix `dirKey`, or `undefined` when no plain directory chain leads there. */
  private async listingDirectory(dirKey: string): Promise<string | undefined> {
    try {
      assertSafeKey(dirKey)
    } catch {
      return undefined // no safe key lies beneath an unsafe prefix
    }
    let current = this.root
    for (const segment of dirKey.split("/")) {
      current = join(current, segment)
      try {
        const info = await lstat(current)
        if (info.isSymbolicLink() || !info.isDirectory()) return undefined
      } catch {
        return undefined
      }
    }
    return current
  }

  private async walk(
    dir: string,
    prefix: string,
    namePrefix: string,
    limit: number,
    out: string[],
  ): Promise<void> {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return // missing root → empty listing
    }
    const entries: { readonly name: string; readonly order: string; readonly kind: string }[] = []
    for (const name of names) {
      if (!name.startsWith(namePrefix)) continue
      const info = await lstat(join(dir, name))
      if (info.isSymbolicLink()) continue
      // A directory's keys all start with `name/`, so it sorts there among its siblings.
      if (info.isDirectory()) entries.push({ name, order: `${name}/`, kind: "dir" })
      else if (info.isFile()) entries.push({ name, order: name, kind: "file" })
    }
    entries.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
    for (const entry of entries) {
      if (out.length >= limit) return
      // POSIX-join the key segments so listed keys are portable regardless of the host separator.
      const key = prefix === "" ? entry.name : posix.join(prefix, entry.name)
      if (entry.kind === "dir") await this.walk(join(dir, entry.name), key, "", limit, out)
      else out.push(key)
    }
  }
}
