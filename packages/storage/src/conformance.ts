import type {
  MovableStorageAdapter,
  PagedStorageAdapter,
  PresignableStorageAdapter,
  StorageAdapter,
} from "./types.ts"

/** Construction and cleanup hooks for {@link assertStorageAdapterConformance}. */
export interface StorageAdapterConformanceOptions {
  /** Return an empty, isolated adapter for this run. */
  readonly createAdapter: () => StorageAdapter | Promise<StorageAdapter>
}

/** A failed invariant reported by {@link assertStorageAdapterConformance}. */
export class StorageAdapterConformanceError extends Error {
  constructor(
    readonly check: string,
    message: string,
    cause?: unknown,
  ) {
    super(`StorageAdapter conformance failed (${check}): ${message}`, { cause })
    this.name = "StorageAdapterConformanceError"
  }
}

const fail = (check: string, message: string, cause?: unknown): never => {
  throw new StorageAdapterConformanceError(check, message, cause)
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

const hasPaging = (storage: StorageAdapter): storage is PagedStorageAdapter =>
  typeof (storage as PagedStorageAdapter).listPage === "function"

const hasPresign = (storage: StorageAdapter): storage is PresignableStorageAdapter =>
  typeof (storage as PresignableStorageAdapter).presign === "function"

const hasMove = (storage: StorageAdapter): storage is MovableStorageAdapter =>
  typeof (storage as MovableStorageAdapter).copy === "function" &&
  typeof (storage as MovableStorageAdapter).move === "function"

/**
 * Execute the observable {@link StorageAdapter} contract without depending on a test runner.
 *
 * The adapter must be isolated because this writes deterministic conformance keys. The promise resolves
 * only after proving byte + metadata round-trips, overwrite, missing/delete semantics, prefix/limit listing,
 * and uniform unsafe-key rejection across every key-taking method. When the adapter also implements an
 * optional capability ({@link PagedStorageAdapter}, {@link PresignableStorageAdapter},
 * {@link MovableStorageAdapter}), that capability's contract is proven too — implementing a capability
 * partially or unsafely fails conformance rather than silently escaping it.
 */
export async function assertStorageAdapterConformance(
  options: StorageAdapterConformanceOptions,
): Promise<void> {
  let storage: StorageAdapter
  try {
    storage = await options.createAdapter()
  } catch (error) {
    return fail("construction", "createAdapter failed", error)
  }

  const a = "nifra-conformance/a/one.txt"
  const b = "nifra-conformance/a/two.bin"
  const c = "nifra-conformance/b/three.bin"

  try {
    await storage.put(a, "one", {
      contentType: "text/x-nifra-conformance",
      metadata: { owner: "nifra", purpose: "conformance" },
    })
    const object = (await storage.get(a)) ?? fail("round trip", "put object was not readable")
    if (!(object.body instanceof Uint8Array)) fail("round trip", "body must be Uint8Array")
    if (decode(object.body) !== "one" || object.size !== 3) {
      fail("round trip", "body or size changed during round-trip")
    }
    if (object.contentType !== "text/x-nifra-conformance") {
      fail("metadata", "contentType did not round-trip")
    }
    if (object.metadata?.owner !== "nifra" || object.metadata.purpose !== "conformance") {
      fail("metadata", "custom metadata did not round-trip")
    }

    if (!(await storage.exists(a))) fail("exists", "stored key was reported missing")
    if (await storage.exists("nifra-conformance/missing")) {
      fail("exists", "missing key was reported present")
    }
    if ((await storage.get("nifra-conformance/missing")) !== null) {
      fail("missing", "get must return null for a missing key")
    }

    await storage.put(a, "overwritten")
    const overwritten = await storage.get(a)
    if (overwritten === null || decode(overwritten.body) !== "overwritten") {
      fail("overwrite", "put did not replace the existing body")
    }

    await storage.put(b, "two")
    await storage.put(c, "three")
    const prefixed = [...(await storage.list({ prefix: "nifra-conformance/a/" }))].sort()
    if (prefixed.length !== 2 || prefixed[0] !== a || prefixed[1] !== b) {
      fail("list prefix", "prefix listing returned unexpected keys")
    }
    if ((await storage.list({ prefix: "nifra-conformance/", limit: 1 })).length !== 1) {
      fail("list limit", "limit was not respected")
    }

    const unsafeCalls: Array<readonly [string, () => Promise<unknown>]> = [
      ["put", () => storage.put("../escape", "x")],
      ["get", () => storage.get("../escape")],
      ["delete", () => storage.delete("../escape")],
      ["exists", () => storage.exists("../escape")],
    ]
    if (hasPaging(storage)) {
      const paged = storage

      // The cursor walk must reproduce exactly the keys list() reports, without duplicates,
      // and must terminate by omitting the cursor on the final page.
      const all = [...(await paged.list({ prefix: "nifra-conformance/" }))].sort()
      const walked: string[] = []
      let cursor: string | undefined
      for (let page = 0; page <= all.length; page++) {
        const result = await paged.listPage({
          prefix: "nifra-conformance/",
          limit: 1,
          ...(cursor !== undefined ? { cursor } : {}),
        })
        if (result.keys.length > 1) fail("listPage limit", "page exceeded the requested limit")
        walked.push(...result.keys)
        cursor = result.cursor
        if (cursor === undefined) break
      }
      if (cursor !== undefined) fail("listPage cursor", "cursor never terminated")
      const sortedWalk = [...walked].sort()
      if (new Set(walked).size !== walked.length) {
        fail("listPage cursor", "cursor walk returned duplicate keys")
      }
      if (sortedWalk.length !== all.length || sortedWalk.some((key, i) => key !== all[i])) {
        fail("listPage cursor", "cursor walk and list() disagree on the key set")
      }
    }

    if (hasMove(storage)) {
      const movable = storage
      const copied = "nifra-conformance/b/copied.bin"
      const moved = "nifra-conformance/b/moved.bin"

      await movable.copy(c, copied)
      const copyTarget = await movable.get(copied)
      const copySource = await movable.get(c)
      if (copyTarget === null || decode(copyTarget.body) !== "three") {
        fail("copy", "copied object is missing or has different bytes")
      }
      if (copySource === null) fail("copy", "copy must not remove the source object")

      await movable.move(copied, moved)
      const moveTarget = await movable.get(moved)
      if (moveTarget === null || decode(moveTarget.body) !== "three") {
        fail("move", "moved object is missing or has different bytes")
      }
      if ((await movable.exists(copied)) || (await movable.get(copied)) !== null) {
        fail("move", "move must remove the source object")
      }
      await movable.delete(moved)

      unsafeCalls.push(
        ["copy source", () => movable.copy("../escape", copied)],
        ["copy destination", () => movable.copy(c, "../escape")],
        ["move source", () => movable.move("../escape", moved)],
        ["move destination", () => movable.move(c, "../escape")],
      )
    }

    if (hasPresign(storage)) {
      const presignable = storage
      for (const operation of ["get", "put"] as const) {
        const presigned = await presignable.presign(a, operation, {
          expiresInSeconds: 60,
          ...(operation === "put" ? { contentType: "text/plain", contentLength: 3 } : {}),
        })
        if (typeof presigned.url !== "string" || presigned.url.length === 0) {
          fail("presign", `${operation} presign did not return a URL`)
        }
        if (presigned.expiresAt !== undefined && presigned.expiresAt.getTime() <= Date.now()) {
          fail("presign", `${operation} presign returned an already-expired URL`)
        }
      }
      unsafeCalls.push(["presign", () => presignable.presign("../escape", "get")])
    }

    for (const [method, call] of unsafeCalls) {
      try {
        await call()
        fail("key safety", `${method} accepted a traversal key`)
      } catch (error) {
        if (error instanceof StorageAdapterConformanceError) throw error
      }
    }

    await storage.delete(a)
    if ((await storage.get(a)) !== null || (await storage.exists(a))) {
      fail("delete", "deleted object remained readable")
    }
    await storage.delete(a)
  } catch (error) {
    if (error instanceof StorageAdapterConformanceError) throw error
    fail("operation", "adapter operation rejected unexpectedly", error)
  } finally {
    await Promise.allSettled([storage.delete(a), storage.delete(b), storage.delete(c)])
  }
}
