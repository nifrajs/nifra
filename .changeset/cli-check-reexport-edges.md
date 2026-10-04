---
"@nifrajs/cli": patch
---

`nifra check` treats a value re-export (`export { x } from "y"`, `export * from "y"`, `export * as ns from "y"`) as an import edge, the way a bundler does. The server-only import scan, its transitive chain through barrel files, and the zone import check (NF-C028) now follow re-exports. `export type …` re-exports, and with a TypeScript install an all-type named re-export, are skipped as before.
