---
"@nifrajs/storage": patch
---

`FileStorage` resolves the directory holding its root once, on first use, and works beneath that real path from then on, checking before every operation that it is still the same directory. Every operation used to re-walk the configured path, so repointing a symbolic link above the root, or renaming an ancestor by whoever could write there, redirected later reads, writes and deletes into another tree; the first now has no effect and the second makes each operation fail with `StorageKeyError`. A root reached through a link that is later repointed keeps using the tree it first resolved until the process restarts.
