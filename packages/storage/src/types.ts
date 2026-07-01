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

/** Normalize any accepted payload to bytes. */
export function toBytes(data: StorageData): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data)
  if (data instanceof Uint8Array) return data
  return new Uint8Array(data)
}
