/**
 * In-process {@link StorageAdapter} — a Map of key → bytes + metadata. For dev and tests; not durable
 * (a restart empties it) and not shared across instances. Methods are `async` so an unsafe key REJECTS
 * (consistent with the disk/R2 adapters), never throws synchronously.
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

interface Entry {
  readonly body: Uint8Array
  readonly contentType?: string
  readonly metadata?: Readonly<Record<string, string>>
}

export class MemoryStorage implements StorageAdapter {
  private readonly objects: Map<string, Entry>

  constructor() {
    this.objects = new Map()
  }

  async put(key: string, data: StorageData, options: PutOptions = {}): Promise<void> {
    assertSafeKey(key)
    const entry: Entry = { body: toBytes(data) }
    this.objects.set(key, {
      ...entry,
      ...(options.contentType !== undefined ? { contentType: options.contentType } : {}),
      ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
    })
  }

  async get(key: string): Promise<StorageObject | null> {
    assertSafeKey(key)
    const entry = this.objects.get(key)
    if (entry === undefined) return null
    return {
      body: entry.body,
      size: entry.body.byteLength,
      ...(entry.contentType !== undefined ? { contentType: entry.contentType } : {}),
      ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
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
