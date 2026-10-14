---
"@nifrajs/storage": patch
---

Concurrent puts of one key from two `FileStorage` instances (two processes) behave as last writer wins. A put whose rename was followed by the other's failed with a false "crosses a symbolic link" error, about 4% of the time under contention. On a root that is its own mount point, where the body is written in place and keeps its inode, the sidecar now also names the body by its SHA-256, so a read never serves one put's body with the other put's content type and metadata (19 of 300 contended reads did).
