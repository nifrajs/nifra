---
"@nifrajs/web": patch
"@nifrajs/cli": patch
"@nifrajs/ts-plugin": patch
---

A package's own `"nifra": { "environment": ... }` may give each export entry its own side: `{ ".": "backend", "./react": "frontend", "./schema": "library" }`. An import is judged by the entry it names, the exact subpath first and then the most specific `*` pattern, so two entries backed by one file keep their own sides; importing an entry the map leaves out is an error, as is a key or side the map cannot use. A file reached by path alone, through a relative or aliased deep import, takes the side of every mapped entry that reaches it through the package's own imports under any export condition, and a file no mapped entry reaches is an error. The Bun and Vite client and server builds, both dev servers, `nifra check` (NF-C028 and NF-C004) and the editor plugin apply the same rules. The Vite builds record the specifier behind each such import, since Rollup keeps only the resolved file. `classify(file, specifier)` on a zone classifier takes the import as written, and `declaredSide(environment, specifier)` reads one declaration. A package-wide string and the app's `"zones": { "packages": ... }` defaults behave as before, and a package's own declaration outranks them. A third-party package's side is read from its root manifest, past a nested `package.json` such as `dist/esm/package.json`.
