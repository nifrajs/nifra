import { describe, expect, test } from "bun:test"
import {
  assertStorageAdapterConformance,
  type ListOptions,
  MemoryStorage,
  type PutOptions,
  type StorageData,
  type StorageObject,
} from "../src/index.ts"
import { assertSafeKey } from "../src/key.ts"

const missing = "nifra-conformance/missing"

/** A memory adapter whose `get` result passes through `edit` for every stored key. */
class EditedGet extends MemoryStorage {
  constructor(private readonly edit: (object: StorageObject) => StorageObject) {
    super()
  }
  override async get(key: string): Promise<StorageObject | null> {
    const object = await super.get(key)
    return object === null ? null : this.edit(object)
  }
}

class PresentForAnyKey extends MemoryStorage {
  override async exists(): Promise<boolean> {
    return true
  }
}

class ReadsMissingKeys extends MemoryStorage {
  override async get(key: string): Promise<StorageObject | null> {
    if (key === missing) return { body: new Uint8Array(), size: 0 }
    return await super.get(key)
  }
}

class KeepsFirstWrite extends MemoryStorage {
  override async put(key: string, data: StorageData, options?: PutOptions): Promise<void> {
    if (!(await this.exists(key))) await super.put(key, data, options)
  }
}

class IgnoresPrefix extends MemoryStorage {
  override async list(options: ListOptions = {}): Promise<string[]> {
    return await super.list({ ...options, prefix: "" })
  }
}

class IgnoresLimit extends MemoryStorage {
  override async list(options: ListOptions = {}): Promise<string[]> {
    const { limit: _limit, ...rest } = options
    return await super.list(rest)
  }
}

class KeepsDeleted extends MemoryStorage {
  override async delete(key: string): Promise<void> {
    // Still refuses an unsafe key, so only the deletion guarantee is broken.
    assertSafeKey(key)
  }
}

class ListRejects extends MemoryStorage {
  override async list(): Promise<string[]> {
    throw new Error("bucket unreachable")
  }
}

describe("storage conformance names the broken guarantee", () => {
  const cases: readonly [string, () => MemoryStorage, string][] = [
    ["a changed size", () => new EditedGet((object) => ({ ...object, size: 99 })), "round trip"],
    [
      "a lost content type",
      () => new EditedGet(({ contentType: _contentType, ...object }) => object),
      "metadata",
    ],
    [
      "lost custom metadata",
      () => new EditedGet(({ metadata: _metadata, ...object }) => object),
      "metadata",
    ],
    ["a missing key reported present", () => new PresentForAnyKey(), "exists"],
    ["a missing key read back", () => new ReadsMissingKeys(), "missing"],
    ["an overwrite that keeps the old body", () => new KeepsFirstWrite(), "overwrite"],
    ["a list that ignores its prefix", () => new IgnoresPrefix(), "list prefix"],
    ["a list that ignores its limit", () => new IgnoresLimit(), "list limit"],
    ["a delete that keeps the object", () => new KeepsDeleted(), "delete"],
    ["an operation that rejects", () => new ListRejects(), "operation"],
  ]
  for (const [label, createAdapter, check] of cases) {
    test(label, async () => {
      await expect(assertStorageAdapterConformance({ createAdapter })).rejects.toMatchObject({
        name: "StorageAdapterConformanceError",
        check,
      })
    })
  }

  test("an adapter that cannot be constructed", async () => {
    await expect(
      assertStorageAdapterConformance({
        createAdapter: () => {
          throw new Error("missing bucket binding")
        },
      }),
    ).rejects.toMatchObject({ check: "construction", cause: expect.any(Error) })
  })
})
