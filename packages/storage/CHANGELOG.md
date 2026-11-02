# @nifrajs/storage

## 5.11.0

No changes in this release.

## 5.10.0

No changes in this release.

## 5.9.0

No changes in this release.

## 5.8.0

No changes in this release.

## 5.7.0

No changes in this release.

## 5.6.0

### Patch Changes

- 60ada50: `FileStorage` no longer refuses a put or read of a key that another instance replaces at the same
  moment. Its containment check resolves the directories above a stored object and holds the object
  itself to a plain file, so it does not depend on the object keeping one inode while it runs. Bun
  1.4.4 on Linux fails `realpath` for a file that a concurrent rename replaces.
- cc6fab1: `FileStorage` keeps its bookkeeping beside the root (`<root>.nifra-state`), where staged bytes and
  sidecars live, private to its owner, and closes such a tree left open by an earlier version on its
  first write. On a root that is its own mount point, a put is staged next to the object under a name
  no key can have and renamed over it, so a failed write leaves the previous object whole and a reader
  never sees part of one; `list()` skips such names. On Windows such a root refuses the put instead of
  writing in place.

## 5.5.1

No changes in this release.

## 5.5.0

### Patch Changes

- 8ec576b: `FileStorage.list()` takes each entry's type from the directory listing instead of an `lstat` per entry, so a listed file costs no stat: a listing costs one directory read per directory it enters, plus one `lstat` that confirms each directory is still a directory just before the walk descends into it. `list({ limit: 1 })` over a flat directory of 5,000 keys went from about 66 ms to about 3 ms locally. Symlinks are still skipped, and an entry whose type the filesystem does not record is still checked with `lstat`.
- 662afb0: `FileStorage.list()` refuses with `StorageKeyError` when the storage root, or a directory the walk is entering, has been replaced by a symlink, instead of listing names from wherever the link points. Each directory is opened and checked against the root and its trusted parents before its names are returned: read through the open descriptor on Linux, and checked by identity before and after the read elsewhere. A missing directory still lists as empty.

## 5.4.0

No changes in this release.

## 5.3.0

### Patch Changes

- 81dbb5e: `FileStorage` resolves the directory holding its root once, on first use, and works beneath that real path from then on, checking before every operation that it is still the same directory. Every operation used to re-walk the configured path, so repointing a symbolic link above the root, or renaming an ancestor by whoever could write there, redirected later reads, writes and deletes into another tree; the first now has no effect and the second makes each operation fail with `StorageKeyError`. A root reached through a link that is later repointed keeps using the tree it first resolved until the process restarts.
- b3ca1d6: Concurrent `FileStorage.put` calls on one key no longer leave a body served with another put's content type and metadata. The body and its metadata sidecar are separate files, so two successful puts could each land one of them last. Puts and deletes of a key on one instance now run one at a time, and a sidecar records the body file it was written with: a read ignores a sidecar naming another body (another process's put landing in between), falling back to the type inferred from the key. Sidecars written by earlier versions are read as before.
- 654d763: `FileStorage` pins the directory holding its root as soon as that directory exists. When the root's parent was missing at first use, the pin stayed on a higher ancestor, so swapping a directory the first put created for a link redirected later reads and writes into another tree; such an operation now fails with `StorageKeyError`.
- 32774b7: Concurrent puts of one key from two `FileStorage` instances (two processes) behave as last writer wins. A put whose rename was followed by the other's failed with a false "crosses a symbolic link" error, about 4% of the time under contention. On a root that is its own mount point, where the body is written in place and keeps its inode, the sidecar now also names the body by its SHA-256, so a read never serves one put's body with the other put's content type and metadata (19 of 300 contended reads did).
- 7881245: On Windows, two `FileStorage` puts of one key at once both succeed again, last writer wins: Windows refuses a rename onto a file while another rename replaces it (`EPERM`, `EACCES`, `EBUSY`), so that rename is now retried for up to about 0.6 s.
- e287d3e: No behavior change: the Windows rename retry is a helper of its own, tested on every platform.
- 40e2ef2: On Windows, a `FileStorage` read no longer serves one put's body with another put's content type and metadata when two instances put one key at once. The sidecar names its body by file ID, read as a JavaScript number; an NTFS file ID can pass 2^53, where two different files round to the same number, so a sidecar could match the other put's body (2 of 200 contended reads on a CI runner). File IDs are now read exactly.

## 5.2.1

No changes in this release.

## 5.2.0

### Patch Changes

- 9498cf8: The package ships its `CHANGELOG.md`, so the installed package has the notes for every version, as the GitHub release does. Before, the tarball held only the code, `README.md`, `LICENSE` and `package.json`.

## 5.1.0

### Patch Changes

- abb4354: The package now ships the MIT `LICENSE` text, as every other @nifrajs package already did.

## 5.0.0

### Minor Changes

- 77a46ce: `FileStorage` now writes each object whole: the data is staged in `<root>.nifra-state` and renamed into place, so a reader never sees a truncated or half-written object and a failed write keeps the previous one. Sidecars for content type and metadata moved to `<root>.nifra-state/metadata`, where they mirror the object paths; a key `a` and a key `a.json/x` can now both carry metadata. Sidecars an earlier version wrote in `<root>.nifra-metadata` are still read, and the next `put` or `delete` of that key removes them.

### Patch Changes

- 08f6940: `FileStorage.list()` now starts below the directories its `prefix` names and stops once it has `limit` keys, walking entries in key order. It used to read the whole tree, then sort and filter, for every call.

## 4.0.2

## 4.0.1

## 4.0.0

### Minor Changes

- 135a29a: `FileStorage` works on a host whose umask is `002`, the default for ordinary users on Debian and Ubuntu. The directories it creates are `0755` whatever the umask, and a group-writable directory it still refuses is named in the error, with the fix. A directory under the root is a key prefix, not an object: `exists()` is `false`, `get()` is `null`, and `delete()` does nothing.

  Every adapter now refuses a key with an empty or `.` segment (`a//b`, `./a`, `a/./b`, `a/`). A file system reads such a key as another key, while an object store keeps the two apart.

- 8dd764b: `R2Storage.list()` returns every key (up to `limit`), following R2's cursor past the 1000 keys a single bucket `list()` call returns. Before, it stopped at the first page, so a cleanup that deleted "everything listed" left the rest behind. `R2Storage` also implements `listPage()`, which returns one page of at most 1000 keys and the opaque cursor for the next.

### Patch Changes

- 01d2d56: `assertStorageAdapterConformance` checks every key shape the storage key contract refuses, on every key-taking method: a nested `..` segment, an absolute key, a backslash, a NUL, an empty key, and an empty, `.`, or trailing segment, where it used to try `../escape` alone. An adapter that refuses only some of them fails the `key safety` check with the method and key named.

## 3.5.0

## 3.4.0

## 3.3.0

## 3.2.0

## 3.1.0

## 3.0.0

## 2.14.1

## 2.14.0

## 2.13.0

## 2.12.1

## 2.12.0

## 2.11.0

## 2.10.0

## 2.9.1

## 2.9.0

## 2.8.2

## 2.8.1

## 2.8.0

## 2.7.1

## 2.7.0

## 2.6.1

## 2.6.0

## 2.5.0

## 2.4.0

## 2.3.0

### Minor Changes

- e8aeab9: Cache, queue and storage operations can produce capability evidence.

  ```ts
  import { useCapability } from "@nifrajs/core/capabilities";

  const cache = createCache({ beacon: useCapability });
  await cache.for(c).set(key, value); // announces `cache.write`, and fails closed if undeclared
  ```

  Static provenance answers what a MODULE can reach, so its evidence is as broad as the module holding
  it. A call answers which ROUTE did what. That is the gap these close: the token is produced by the
  operation rather than by a policy file asserting an import implies it.

  `useCapability` is passed in rather than imported, so all three packages keep their zero dependencies -
  a cache should not pull the server into a bundle that only wanted a cache. Nothing changes for existing
  code: the unbound `cache.set(...)`, `job.enqueue(...)` and `adapter.put(...)` paths are untouched, and
  `for(context)` without a configured beacon throws rather than handing back something that quietly
  produces no evidence.

  Storage takes a `withCapabilityBeacon(adapter, { beacon })` wrapper instead of an interface method,
  because `StorageAdapter` is meant to be implemented outside the package and a new method would break
  every adapter already written. `cache.wrap` announces read AND write, since a miss writes and which one
  happens is not knowable before the call.

### Patch Changes

- cee03d7: The beacon wrapper stops breaking adapters that use `#private` fields, and the `--db` sample no longer
  collides with a template route.

  A `#` field's brand check is per-instance, so a Proxy that passes itself as the receiver throws
  `Cannot access invalid private field`. Getters broke on both views and methods broke on the unbound
  one - an adapter using `#` worked unwrapped and broke the moment you added beacons. Both proxies now
  read against the target, and the unbound one binds methods to it.

  The generated `db/read-routes.ts` registered `GET /notes`, which the fullstack template already
  registers. `nifra check` associates modules with routes by matching the registered path across your
  source, so that unmerged sample lent its `db.read` reach to a template route that never touches the
  database - failing the check on a fresh `create-nifra --template fullstack --db …`. The sample uses
  `/db/notes` now, and says why.

- 389861b: `withCapabilityBeacon` no longer deletes an adapter's optional capabilities.

  It assembled its return value from five hand-listed methods, so wrapping a presignable or movable
  adapter silently dropped `presign`, `listPage`, `copy` and `move`. A certified S3 adapter came back
  unable to sign a URL - no error, no option, and `presign` is the method most worth beaconing, since a
  PUT URL hands out write access.

  Forwarding is now by Proxy, which cannot miss a method by construction, and the wrapper is generic so
  the wrapped type keeps its extensions. `presign` announces read or write by its `operation` argument;
  `listPage` reads; `copy` and `move` write; a method nobody mapped announces write, because a
  declaration says what a route MAY do and an unmapped extension should fail closed against a read-only
  route rather than slip through unannounced.

- ea0a27f: The beacon wrapper survives a frozen adapter, and file writes cannot be raced onto a symlink.

  A Proxy may not report a different value for a non-writable, non-configurable own property, so wrapping
  a frozen adapter whose methods are own properties threw a Proxy invariant error before the wrapper
  could run - measured, not theorised. The beacon now proxies an extensible facade and delegates every
  read, write and call to the real instance, so `instanceof`, `#private` brands and frozen adapters all
  keep working. Methods are cached per wrapper, so repeated property reads keep their identity and
  allocate once.

  `FileStorage` opened its target with `O_TRUNC` after checking the path, which leaves a window between
  the check and the open: winning it pointed the descriptor at a file outside the storage root and
  truncated it. The open no longer truncates. The descriptor is compared against the path's current inode
  and its resolved location is confirmed to be inside the root, and only then is anything destroyed.

## 2.2.0

## 2.1.0

## 2.0.0

## 1.13.0

## 1.12.0

## 1.11.0

## 1.10.0

## 1.9.1

## 1.9.0

## 1.8.0

## 1.7.0

## 1.6.0

## 1.5.0

### Patch Changes

- bd3433f: Security + correctness hardening: `FileStorage` refuses paths that cross symbolic links (component-wise `lstat` walk + `O_NOFOLLOW` writes; `list()` skips symlinks) so a planted symlink can no longer redirect reads/writes outside the storage root. OTel spans no longer copy raw `Error.message` into exported attributes (exception text routinely carries credentials/URLs); spans record `error.recorded: true` instead. New `onResponseFinalized` terminal observer on the server (`Middleware.onResponseFinalized` / `ResponseFinalization`) runs after every transforming `onResponse` hook and is fail-open - tracing now records the true final status even when a later hook rewrites or throws. OpenAPI generation sanitizes URI-style `$id` values into valid component names/`$ref` pointers (hex-derived, collision-suffixed) and is immune to `__proto__` key pollution.

## 1.4.0

### Minor Changes

- 4d25970: Add one fail-open request-observation lifecycle shared by tracing, agent telemetry, and DevTools; secured development tooling; contract-based mock responses; validator-neutral schema/route reflection; executable render and storage adapter conformance modules; optional storage pagination/signing/copy capabilities; and metadata-preserving local file storage.

## 1.3.1

## 1.3.0

## 1.2.2

## 1.2.1

## 1.2.0

## 1.1.0

### Minor Changes

- af27cb5: feat(storage): add `@nifrajs/storage` - blob storage with pluggable adapters

  One `StorageAdapter` interface (`put` / `get` / `delete` / `exists` / `list`) with three adapters:
  `MemoryStorage` (dev/tests), `FileStorage` (local disk, traversal-safe), and `R2Storage` (Cloudflare R2,
  binding typed structurally - no `@cloudflare/workers-types`). The persistence half of `@nifrajs/uploads`.
  Every adapter rejects unsafe keys (absolute, `..` traversal, NUL, backslash) via `assertSafeKey`, so a
  `FileStorage` key can't escape its root and keys are portable across adapters. Dependency-free; implement
  `StorageAdapter` for S3/GCS.
