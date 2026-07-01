/**
 * Cloudflare R2 {@link StorageAdapter} — wraps an R2 bucket binding. The binding is typed structurally
 * (the slice we use), so this stays dependency-free: no `@cloudflare/workers-types`. Pass `env.MY_BUCKET`.
 *
 *   const storage = new R2Storage(env.UPLOADS)
 */
import { assertSafeKey } from "./key.ts"
import {
  type ListOptions,
  type PutOptions,
  type StorageAdapter,
  type StorageData,
  type StorageObject,
  toBytes,
} from "./types.ts"

/** The slice of R2's object metadata this adapter reads. */
export interface R2ObjectLike {
  readonly size: number
  readonly httpMetadata?: { readonly contentType?: string }
  readonly customMetadata?: Record<string, string>
}

/** The slice of the R2 bucket binding this adapter calls. `env.<BUCKET>` satisfies it. */
export interface R2BucketLike {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>
  get(key: string): Promise<(R2ObjectLike & { arrayBuffer(): Promise<ArrayBuffer> }) | null>
  head(key: string): Promise<R2ObjectLike | null>
  delete(key: string): Promise<void>
  list(options?: {
    prefix?: string
    limit?: number
  }): Promise<{ objects: ReadonlyArray<{ key: string }> }>
}

export class R2Storage implements StorageAdapter {
  constructor(private readonly bucket: R2BucketLike) {}

  async put(key: string, data: StorageData, options: PutOptions = {}): Promise<void> {
    assertSafeKey(key)
    const put: {
      httpMetadata?: { contentType?: string }
      customMetadata?: Record<string, string>
    } = {}
    if (options.contentType !== undefined) put.httpMetadata = { contentType: options.contentType }
    if (options.metadata !== undefined) put.customMetadata = { ...options.metadata }
    // R2 wants a copied ArrayBuffer (not a view into a larger buffer).
    await this.bucket.put(key, toBytes(data).slice().buffer, put)
  }

  async get(key: string): Promise<StorageObject | null> {
    assertSafeKey(key)
    const object = await this.bucket.get(key)
    if (object === null) return null
    const body = new Uint8Array(await object.arrayBuffer())
    return {
      body,
      size: object.size,
      ...(object.httpMetadata?.contentType !== undefined
        ? { contentType: object.httpMetadata.contentType }
        : {}),
      ...(object.customMetadata !== undefined ? { metadata: object.customMetadata } : {}),
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key)
    await this.bucket.delete(key)
  }

  async exists(key: string): Promise<boolean> {
    assertSafeKey(key)
    return (await this.bucket.head(key)) !== null
  }

  async list(options: ListOptions = {}): Promise<string[]> {
    const listOpts: { prefix?: string; limit?: number } = {}
    if (options.prefix !== undefined) listOpts.prefix = options.prefix
    if (options.limit !== undefined) listOpts.limit = options.limit
    const result = await this.bucket.list(listOpts)
    return result.objects.map((o) => o.key)
  }
}
