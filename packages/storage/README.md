# @nifrajs/storage

Blob storage for nifra — one `StorageAdapter` interface, several adapters. The **persistence half of
[`@nifrajs/uploads`](../uploads)**: `uploads` decides what's allowed (MIME, size, signed URLs, EXIF
stripping); `storage` puts the bytes somewhere. **Dependency-free.**

```ts
import { FileStorage } from "@nifrajs/storage"

const storage = new FileStorage("./uploads")
await storage.put("avatars/u1.png", bytes, { contentType: "image/png" })

const object = await storage.get("avatars/u1.png") // { body, size, contentType?, metadata? } | null
await storage.delete("avatars/u1.png")
const keys = await storage.list({ prefix: "avatars/" })
```

## Adapters

| Adapter | Use | Notes |
|---|---|---|
| `MemoryStorage` | dev / tests | not durable, not shared across instances |
| `FileStorage(root)` | a long-running server (Bun/Node/Deno) | bytes-only: `contentType` inferred from the extension, custom metadata not persisted |
| `R2Storage(env.BUCKET)` | the edge (Cloudflare R2) | round-trips `contentType` + metadata; binding typed structurally (no `@cloudflare/workers-types`) |

Implement `StorageAdapter` (`put` / `get` / `delete` / `exists` / `list`) for **S3 / GCS / anything else** —
the same five methods, and your routes don't change.

## Key safety

Keys are POSIX-ish relative paths (`avatars/u1.png`). **Every** adapter rejects unsafe keys — absolute
paths, `..` traversal, NUL bytes, backslashes — via `assertSafeKey`, so a `FileStorage` key can never
escape its root and a key valid in one adapter is valid in all.

```ts
import { assertSafeKey, StorageKeyError } from "@nifrajs/storage"
```

## API

- `new MemoryStorage()` · `new FileStorage(root)` · `new R2Storage(bucket)`.
- `put(key, data, { contentType?, metadata? })` — `data` is `Uint8Array | ArrayBuffer | string`.
- `get(key)` → `{ body, size, contentType?, metadata? } | null` · `delete(key)` · `exists(key)` · `list({ prefix?, limit? })`.
- `assertSafeKey(key)` / `StorageKeyError` · `toBytes(data)`.
