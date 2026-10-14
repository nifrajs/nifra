---
"@nifrajs/storage": patch
---

Concurrent `FileStorage.put` calls on one key no longer leave a body served with another put's content type and metadata. The body and its metadata sidecar are separate files, so two successful puts could each land one of them last. Puts and deletes of a key on one instance now run one at a time, and a sidecar records the body file it was written with: a read ignores a sidecar naming another body (another process's put landing in between), falling back to the type inferred from the key. Sidecars written by earlier versions are read as before.
