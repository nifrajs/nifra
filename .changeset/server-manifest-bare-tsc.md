---
"@nifrajs/web": patch
---

The generated `server-manifest.ts` now imports each route module by an extensionless specifier, so a
plain `tsc` over the project compiles it without `allowImportingTsExtensions`. Previously the manifest
emitted `.tsx`/`.ts` import paths that only `nifra check` (which sets that flag) accepted, and a bare
`tsc` reported TS5097 for every route. Route identity is unchanged: the manifest map keys still carry
the original file path with its extension.

Manifest drift detection (`nifra check`, `nifra sync-manifest`) now reads those extension-bearing map
keys rather than the import specifiers, so it keeps matching the discovered `routes/` tree exactly and
does not false-report every route as drifted against the extensionless specifiers.
