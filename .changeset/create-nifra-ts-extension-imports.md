---
"create-nifra": patch
---

A `site` or `isr` scaffold created with `--db` now passes `tsc`. Its database modules import each other as `./schema.ts`, which the generated `tsconfig.json` refused with TS5097. That tsconfig now sets `allowImportingTsExtensions`, as the `api` and `batteries` templates already did.
