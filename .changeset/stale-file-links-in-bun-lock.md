---
"@nifrajs/cli": minor
---

`nifra doctor` and `nifra check` (NF-D003) report a `file:` dependency whose recorded dependencies in `bun.lock` differ from what its `package.json` declares now. Bun records them once and never reads that `package.json` again, even under `bun install --force`, so it keeps installing the recorded versions beside the declared ones. The fix is `bun update <package>`. `nifra upgrade` reads the lock against the manifests it is about to write: a dry run lists the entries it would leave stale, and `--write` drops them so the next `bun install` records them again. A lock not laid out one entry per line is left alone and the `bun update` is named instead. The mixed-versions advisory (NF-D002) also counts an exact nifra pin such an entry records.
