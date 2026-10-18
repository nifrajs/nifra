---
"@nifrajs/content": patch
---

A collection with `watch` on re-reads a file that was replaced in place with the same size and modification time, as a deploy or sync tool does when it preserves times. Its cache recognised a file by size and mtime alone, so `get()` and `all()` kept serving the old content until either changed. The cache now also compares the file's device, inode and change time.
