/**
 * In-process {@link StorageAdapter} - a Map of key → bytes + metadata. For dev and tests; not durable
 * (a restart empties it) and not shared across instances. Methods are `async` so an unsafe key REJECTS
 * (consistent with the disk/R2 adapters), never throws synchronously.
 */
import { assertSafeKey } from "./key.ts"
import {
  type ListOptions,
  type PutOptions,
  type StorageData,
  type StorageObject,
  type StorageObjectMetadata,
  type StorageStreamObject,
  type StreamableStorageAdapter,
  toBytes,
} from "./types.ts"

interface Entry {
  readonly body: Uint8Array
  readonly contentType?: string
  readonly metadata?: Readonly<Record<string, string>>
}

function objectMetadata(
  size: number,
  contentType: string | undefined,
  metadata: Readonly<Record<string, string>> | undefined,
): StorageObjectMetadata {
  const result: {
    size: number
    contentType?: string
    metadata?: Readonly<Record<string, string>>
  } = { size }
  if (contentType !== undefined) result.contentType = contentType
  if (metadata !== undefined) result.metadata = metadata
  return result
}

export class MemoryStorage implements StreamableStorageAdapter {
  private readonly objects: Map<string, Entry>

  constructor() {
    this.objects = new Map()
  }

  async put(key: string, data: StorageData, options: PutOptions = {}): Promise<void> {
    assertSafeKey(key)
    const entry: {
      body: Uint8Array
      contentType?: string
      metadata?: Readonly<Record<string, string>>
    } = { body: toBytes(data) }
    if (options.contentType !== undefined) entry.contentType = options.contentType
    if (options.metadata !== undefined) entry.metadata = options.metadata
    this.objects.set(key, entry)
  }

  async putStream(
    key: string,
    stream: ReadableStream<Uint8Array>,
    options: PutOptions = {},
  ): Promise<void> {
    assertSafeKey(key)
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        total += value.byteLength
      }
    } finally {
      reader.releaseLock()
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    await this.put(key, merged, options)
  }

  async get(key: string): Promise<StorageObject | null> {
    assertSafeKey(key)
    const entry = this.objects.get(key)
    if (entry === undefined) return null
    return {
      body: entry.body,
      ...objectMetadata(entry.body.byteLength, entry.contentType, entry.metadata),
    }
  }

  async head(key: string): Promise<StorageObjectMetadata | null> {
    assertSafeKey(key)
    const entry = this.objects.get(key)
    if (entry === undefined) return null
    return objectMetadata(entry.body.byteLength, entry.contentType, entry.metadata)
  }

  async getStream(key: string): Promise<StorageStreamObject | null> {
    assertSafeKey(key)
    const entry = this.objects.get(key)
    if (entry === undefined) return null
    const snapshot = entry.body
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (snapshot.byteLength > 0) controller.enqueue(snapshot)
        controller.close()
      },
    })
    return {
      body,
      ...objectMetadata(snapshot.byteLength, entry.contentType, entry.metadata),
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key)
    this.objects.delete(key)
  }

  async exists(key: string): Promise<boolean> {
    assertSafeKey(key)
    return this.objects.has(key)
  }

  async list(options: ListOptions = {}): Promise<string[]> {
    const prefix = options.prefix ?? ""
    let keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort()
    if (options.limit !== undefined) keys = keys.slice(0, options.limit)
    return keys
  }
}
