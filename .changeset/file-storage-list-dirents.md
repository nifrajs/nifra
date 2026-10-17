---
"@nifrajs/storage": patch
---

`FileStorage.list()` takes each entry's type from the directory listing instead of an `lstat` per entry, so a listing costs one directory read per directory it enters. `list({ limit: 1 })` over a flat directory of 5,000 keys went from about 66 ms to about 3 ms locally. Symlinks are still skipped, and an entry whose type the filesystem does not record is still checked with `lstat`.
