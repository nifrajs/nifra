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
| `FileStorage(root)` | a long-running server (Bun/Node/Deno) | persists content type + custom metadata in an adjacent sidecar tree; legacy objects still infer MIME from extension |
| `R2Storage(env.BUCKET)` | the edge (Cloudflare R2) | round-trips `contentType` + metadata; binding typed structurally (no `@cloudflare/workers-types`) |

Implement `StorageAdapter` (`put` / `get` / `delete` / `exists` / `list`) for **S3 / GCS / anything else** —
the same five methods, and your routes don't change.

Run the executable contract against third-party adapters:

```ts
import { assertStorageAdapterConformance } from "@nifrajs/storage"

await assertStorageAdapterConformance({ createAdapter: () => new MyStorage() })
```

Provider-specific mechanics stay optional: implement `PagedStorageAdapter`, `PresignableStorageAdapter`,
and/or `MovableStorageAdapter` only when the provider supports cursor listing, URL signing, or server-side
copy/move. Asset sensitivity, bucket routing, credentials, and TTL policy belong in the consuming app or
private package—not in these mechanical interfaces.

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
- `assertStorageAdapterConformance({ createAdapter })` — dependency-free executable adapter contract.
- Optional interfaces: `PagedStorageAdapter` · `PresignableStorageAdapter` · `MovableStorageAdapter`.

## For AI agents

Start with [`LLM.md`](./LLM.md) — this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
