/**
 * @nifrajs/storage — one blob-storage interface, several adapters. The persistence half of
 * `@nifrajs/uploads` (which validates + signs but doesn't store): `uploads` decides what's allowed,
 * `storage` puts the bytes somewhere. Adapters: {@link MemoryStorage} (dev/test), `FileStorage` (local
 * disk), `R2Storage` (Cloudflare R2). Bring your own for S3/GCS by implementing {@link StorageAdapter}.
 */

/** Accepted `put` payloads — normalized to bytes by each adapter. */
export type StorageData = Uint8Array | ArrayBuffer | string

export interface PutOptions {
  /** MIME type stored alongside the object (returned by `get`). */
  readonly contentType?: string
  /** Arbitrary string metadata stored with the object. */
  readonly metadata?: Readonly<Record<string, string>>
}

/** An object read back from storage. `body` is buffered (not streamed) — fine for typical uploads. */
export interface StorageObject {
  readonly body: Uint8Array
  readonly size: number
  readonly contentType?: string
  readonly metadata?: Readonly<Record<string, string>>
}

export interface ListOptions {
  /** Only keys starting with this prefix. */
  readonly prefix?: string
  /** Cap the number of keys returned. */
  readonly limit?: number
}

/** One page of keys from stores that expose cursor-based listing. */
export interface StorageListPage {
  readonly keys: readonly string[]
  /** Opaque cursor for the next page; absent when this is the final page. */
  readonly cursor?: string
}

/** Cursor-aware listing options. `cursor` is adapter-owned and must be treated as opaque. */
export interface StorageListPageOptions extends ListOptions {
  readonly cursor?: string
}

/** Operation represented by a presigned storage URL. */
export type StoragePresignOperation = "get" | "put"

/** Mechanical constraints applied while minting a presigned URL. */
export interface StoragePresignOptions {
  readonly expiresInSeconds?: number
  /** For PUT URLs, pin the declared MIME type. */
  readonly contentType?: string
  /** For PUT URLs, pin the exact request-body size. */
  readonly contentLength?: number
}

/** A provider-minted URL and its known expiry. */
export interface StoragePresignedUrl {
  readonly url: string
  readonly expiresAt?: Date
}

/**
 * A blob store keyed by string. Keys are POSIX-ish paths (`avatars/u1.png`); every adapter rejects unsafe
 * keys (absolute, `..` traversal, NUL, backslash) so a key valid in one adapter is valid in all. All
 * methods are async.
 */
export interface StorageAdapter {
  /** Store `data` under `key`, overwriting any existing object. */
  put(key: string, data: StorageData, options?: PutOptions): Promise<void>
  /** Read the object at `key`, or `null` if it doesn't exist. */
  get(key: string): Promise<StorageObject | null>
  /** Remove `key`. No-op if it doesn't exist. */
  delete(key: string): Promise<void>
  /** Whether an object exists at `key`. */
  exists(key: string): Promise<boolean>
  /** List stored keys (optionally filtered by prefix + capped). */
  list(options?: ListOptions): Promise<string[]>
}

/** Optional cursor-listing capability. Kept out of {@link StorageAdapter} for simple stores. */
export interface PagedStorageAdapter extends StorageAdapter {
  listPage(options?: StorageListPageOptions): Promise<StorageListPage>
}

/** Optional provider-side URL-signing capability. Asset sensitivity and TTL policy stay with callers. */
export interface PresignableStorageAdapter extends StorageAdapter {
  presign(
    key: string,
    operation: StoragePresignOperation,
    options?: StoragePresignOptions,
  ): Promise<StoragePresignedUrl>
}

/** Optional server-side copy/move capability. */
export interface MovableStorageAdapter extends StorageAdapter {
  copy(sourceKey: string, destinationKey: string): Promise<void>
  move(sourceKey: string, destinationKey: string): Promise<void>
}

/** Normalize any accepted payload to bytes. */
export function toBytes(data: StorageData): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data)
  if (data instanceof Uint8Array) return data
  return new Uint8Array(data)
}
