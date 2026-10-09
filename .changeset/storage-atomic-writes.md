---
"@nifrajs/storage": minor
---

`FileStorage` now writes each object whole: the data is staged in `<root>.nifra-state` and renamed into place, so a reader never sees a truncated or half-written object and a failed write keeps the previous one. Sidecars for content type and metadata moved to `<root>.nifra-state/metadata`, where they mirror the object paths; a key `a` and a key `a.json/x` can now both carry metadata. Sidecars an earlier version wrote in `<root>.nifra-metadata` are still read, and the next `put` or `delete` of that key removes them.
