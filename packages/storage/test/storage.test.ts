import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  FileStorage,
  MemoryStorage,
  type R2BucketLike,
  type R2ObjectLike,
  R2Storage,
  type StorageAdapter,
} from "../src/index.ts"

/** An in-memory fake of the R2 binding so `R2Storage`'s mapping is exercised without real R2. Uses
 * conditional spreads (not `field: undefined`) to satisfy `exactOptionalPropertyTypes`. */
class FakeR2 implements R2BucketLike {
  private readonly m = new Map<
    string,
    { body: Uint8Array; ct?: string; meta?: Record<string, string> }
  >()

  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> },
  ): Promise<unknown> {
    const body =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    const ct = options?.httpMetadata?.contentType
    const meta = options?.customMetadata
    this.m.set(key, {
      body,
      ...(ct !== undefined ? { ct } : {}),
      ...(meta !== undefined ? { meta } : {}),
    })
    return Promise.resolve(undefined)
  }

  get(key: string): Promise<(R2ObjectLike & { arrayBuffer(): Promise<ArrayBuffer> }) | null> {
    const e = this.m.get(key)
    if (e === undefined) return Promise.resolve(null)
    return Promise.resolve({
      size: e.body.byteLength,
      arrayBuffer: () => Promise.resolve(e.body.slice().buffer),
      ...(e.ct !== undefined ? { httpMetadata: { contentType: e.ct } } : {}),
      ...(e.meta !== undefined ? { customMetadata: e.meta } : {}),
    })
  }

  head(key: string): Promise<R2ObjectLike | null> {
    const e = this.m.get(key)
    return Promise.resolve(e === undefined ? null : { size: e.body.byteLength })
  }

  delete(key: string): Promise<void> {
    this.m.delete(key)
    return Promise.resolve()
  }

  list(options?: {
    prefix?: string
    limit?: number
  }): Promise<{ objects: ReadonlyArray<{ key: string }> }> {
    let keys = [...this.m.keys()]
    if (options?.prefix !== undefined) keys = keys.filter((k) => k.startsWith(options.prefix ?? ""))
    if (options?.limit !== undefined) keys = keys.slice(0, options.limit)
    return Promise.resolve({ objects: keys.map((key) => ({ key })) })
  }
}

const tmpDirs: string[] = []
afterAll(() => Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true }))))
async function freshFileStorage(): Promise<FileStorage> {
  const dir = await mkdtemp(join(tmpdir(), "nifra-storage-"))
  tmpDirs.push(dir)
  return new FileStorage(dir)
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
function present<T>(value: T | null): T {
  if (value === null) throw new Error("expected a non-null storage object")
  return value
}

const adapters: Array<[string, () => Promise<StorageAdapter>]> = [
  ["MemoryStorage", () => Promise.resolve(new MemoryStorage())],
  ["FileStorage", () => freshFileStorage()],
  ["R2Storage(fake)", () => Promise.resolve(new R2Storage(new FakeR2()))],
]

for (const [name, make] of adapters) {
  describe(`StorageAdapter — ${name}`, () => {
    test("put → get round-trips bytes (string input)", async () => {
      const s = await make()
      await s.put("a/b.txt", "hello")
      const object = present(await s.get("a/b.txt"))
      expect(decode(object.body)).toBe("hello")
      expect(object.size).toBe(5)
    })

    test("missing → null; exists reflects presence", async () => {
      const s = await make()
      expect(await s.get("missing")).toBeNull()
      expect(await s.exists("missing")).toBe(false)
      await s.put("here", "x")
      expect(await s.exists("here")).toBe(true)
    })

    test("delete removes; deleting a missing key is a no-op", async () => {
      const s = await make()
      await s.put("k", "v")
      await s.delete("k")
      expect(await s.get("k")).toBeNull()
      await s.delete("k") // no throw
    })

    test("overwrite replaces the bytes", async () => {
      const s = await make()
      await s.put("k", "one")
      await s.put("k", "two")
      expect(decode(present(await s.get("k")).body)).toBe("two")
    })

    test("list returns keys filtered by prefix + capped by limit", async () => {
      const s = await make()
      await s.put("a/1", "x")
      await s.put("a/2", "x")
      await s.put("b/1", "x")
      expect([...(await s.list())].sort()).toEqual(["a/1", "a/2", "b/1"])
      expect([...(await s.list({ prefix: "a/" }))].sort()).toEqual(["a/1", "a/2"])
      expect((await s.list({ limit: 1 })).length).toBe(1)
    })

    test("rejects unsafe keys (traversal)", async () => {
      const s = await make()
      await expect(s.put("../escape", "x")).rejects.toThrow()
    })
  })
}

describe("contentType + metadata", () => {
  test("Memory + R2 round-trip contentType and metadata", async () => {
    for (const s of [new MemoryStorage(), new R2Storage(new FakeR2())] as StorageAdapter[]) {
      await s.put("k", "x", { contentType: "image/png", metadata: { owner: "u1" } })
      const object = present(await s.get("k"))
      expect(object.contentType).toBe("image/png")
      expect(object.metadata).toEqual({ owner: "u1" })
    }
  })

  test("File infers contentType from the extension; custom metadata is not persisted", async () => {
    const s = await freshFileStorage()
    await s.put("photo.png", "x", { contentType: "ignored", metadata: { a: "b" } })
    const object = present(await s.get("photo.png"))
    expect(object.contentType).toBe("image/png") // inferred from `.png`
    expect(object.metadata).toBeUndefined()
  })
})
