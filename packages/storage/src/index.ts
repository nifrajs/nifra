/**
 * @nifrajs/storage — one blob-storage interface, several adapters. The persistence half of
 * `@nifrajs/uploads`: `uploads` validates + signs, `storage` puts the bytes somewhere. Adapters cover
 * dev (memory), a long-running server (local disk), and the edge (Cloudflare R2); implement
 * {@link StorageAdapter} for S3/GCS/etc. Dependency-free.
 *
 *   import { FileStorage } from "@nifrajs/storage"
 *   const storage = new FileStorage("./uploads")
 *   await storage.put("avatars/u1.png", bytes, { contentType: "image/png" })
 *   const object = await storage.get("avatars/u1.png")
 */

export { FileStorage } from "./file.ts"
export { assertSafeKey, StorageKeyError } from "./key.ts"
export { MemoryStorage } from "./memory.ts"
export { type R2BucketLike, type R2ObjectLike, R2Storage } from "./r2.ts"
export {
  type ListOptions,
  type PutOptions,
  type StorageAdapter,
  type StorageData,
  type StorageObject,
  toBytes,
} from "./types.ts"
