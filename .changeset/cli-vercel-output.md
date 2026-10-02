---
"@nifrajs/cli": patch
---

`nifra build` for the `vercel` target writes to `.vercel/output`, where `vercel deploy --prebuilt`
reads it, unless `--out` names another directory.
