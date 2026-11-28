/**
 * Cloudflare R2 {@link StorageAdapter} - wraps an R2 bucket binding. The binding is typed structurally
 * (the slice we use), so this stays dependency-free: no `@cloudflare/workers-types`. Pass `env.MY_BUCKET`.
 *
 *   const storage = new R2Storage(env.UPLOADS)
 */
import { assertSafeKey } from "./key.ts"
import {
  type ListOptions,
  type PagedStorageAdapter,
  type PutOptions,
  type StorageData,
  type StorageListPage,
  type StorageListPageOptions,
  type StorageObject,
  type StorageObjectMetadata,
  type StorageStreamObject,
  type StreamableStorageAdapter,
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
    value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown>
  get(key: string): Promise<
    | (R2ObjectLike & {
        readonly body?: ReadableStream<Uint8Array>
        arrayBuffer(): Promise<ArrayBuffer>
      })
    | null
  >
  head(key: string): Promise<R2ObjectLike | null>
  delete(key: string): Promise<void>
  list(options?: {
    prefix?: string
    limit?: number
    cursor?: string
  }): Promise<{ objects: ReadonlyArray<{ key: string }>; truncated?: boolean; cursor?: string }>
}

/** The most keys one R2 `list()` call returns; the rest arrive behind its cursor. */
const R2_PAGE = 1000

export class R2Storage implements StreamableStorageAdapter, PagedStorageAdapter {
  private readonly maxReadBytes: number

  constructor(
    private readonly bucket: R2BucketLike,
    options: { readonly maxReadBytes?: number } = {},
  ) {
    this.maxReadBytes = options.maxReadBytes ?? 16 * 1024 * 1024
    if (!Number.isSafeInteger(this.maxReadBytes) || this.maxReadBytes < 0) {
      throw new RangeError("R2Storage maxReadBytes must be a non-negative safe integer")
    }
  }

  private putOptions(options: PutOptions): {
    httpMetadata?: { contentType?: string }
    customMetadata?: Record<string, string>
  } {
    const put: {
      httpMetadata?: { contentType?: string }
      customMetadata?: Record<string, string>
    } = {}
    if (options.contentType !== undefined) put.httpMetadata = { contentType: options.contentType }
    if (options.metadata !== undefined) put.customMetadata = { ...options.metadata }
    return put
  }

  async put(key: string, data: StorageData, options: PutOptions = {}): Promise<void> {
    assertSafeKey(key)
    // R2 wants a copied ArrayBuffer (not a view into a larger buffer).
    await this.bucket.put(key, toBytes(data).slice().buffer, this.putOptions(options))
  }

  async putStream(
    key: string,
    stream: ReadableStream<Uint8Array>,
    options: PutOptions = {},
  ): Promise<void> {
    assertSafeKey(key)
    await this.bucket.put(key, stream, this.putOptions(options))
  }

  private objectMetadata(object: R2ObjectLike): StorageObjectMetadata {
    const result: {
      size: number
      contentType?: string
      metadata?: Readonly<Record<string, string>>
    } = { size: object.size }
    if (object.httpMetadata?.contentType !== undefined) {
      result.contentType = object.httpMetadata.contentType
    }
    if (object.customMetadata !== undefined) result.metadata = object.customMetadata
    return result
  }

  /** Read up to `maxReadBytes` (16 MiB by default). An oversized object throws a RangeError. */
  async get(key: string): Promise<StorageObject | null> {
    assertSafeKey(key)
    const object = await this.bucket.get(key)
    if (object === null) return null
    if (!Number.isSafeInteger(object.size) || object.size < 0 || object.size > this.maxReadBytes) {
      await object.body?.cancel().catch(() => {
        // Preserve the size error if the platform already closed the body.
      })
      throw new RangeError("R2Storage object exceeds maxReadBytes or has invalid size metadata")
    }
    const body = new Uint8Array(await object.arrayBuffer())
    if (body.byteLength > this.maxReadBytes) {
      throw new RangeError("R2Storage object exceeds maxReadBytes")
    }
    return {
      body,
      ...this.objectMetadata(object),
    }
  }

  async head(key: string): Promise<StorageObjectMetadata | null> {
    assertSafeKey(key)
    const object = await this.bucket.head(key)
    if (object === null) return null
    return this.objectMetadata(object)
  }

  async getStream(key: string): Promise<StorageStreamObject | null> {
    assertSafeKey(key)
    const object = await this.bucket.get(key)
    if (object === null) return null
    let body: ReadableStream<Uint8Array>
    if (object.body !== undefined) {
      body = object.body
    } else {
      const bytes = new Uint8Array(await object.arrayBuffer())
      body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (bytes.byteLength > 0) controller.enqueue(bytes)
          controller.close()
        },
      })
    }
    return {
      body,
      ...this.objectMetadata(object),
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

  /** Every key (up to `limit`), following R2's cursor past the 1000 keys one call returns. */
  async list(options: ListOptions = {}): Promise<string[]> {
    const keys: string[] = []
    let cursor: string | undefined
    do {
      const pageOptions: { prefix?: string; limit?: number; cursor?: string } = {}
      if (options.prefix !== undefined) pageOptions.prefix = options.prefix
      if (options.limit !== undefined) pageOptions.limit = options.limit - keys.length
      if (cursor !== undefined) pageOptions.cursor = cursor
      const page = await this.listPage(pageOptions)
      keys.push(...page.keys)
      cursor = page.cursor
    } while (cursor !== undefined && (options.limit === undefined || keys.length < options.limit))
    return keys
  }

  /** One page of at most 1000 keys, and the cursor for the next while there are more. */
  async listPage(options: StorageListPageOptions = {}): Promise<StorageListPage> {
    const listOpts: { prefix?: string; limit?: number; cursor?: string } = {}
    if (options.prefix !== undefined) listOpts.prefix = options.prefix
    if (options.limit !== undefined) listOpts.limit = Math.min(options.limit, R2_PAGE)
    if (options.cursor !== undefined) listOpts.cursor = options.cursor
    const result = await this.bucket.list(listOpts)
    const keys = result.objects.map((o) => o.key)
    return result.truncated === true && result.cursor !== undefined
      ? { keys, cursor: result.cursor }
      : { keys }
  }
}
