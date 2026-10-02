---
"@nifrajs/cli": minor
---

fix(cli): `nifra check` follows a literal dynamic `import()` from browser code

The backend-code check (NF-C004) treats `import("../lib/x")` with a string-literal specifier like a
static import: from a page and through its local imports, down to backend code, a Node built-in, a
known server package or a module marked `@nifrajs/web/backend-only`. The client build bundles a
dynamic import's target as a lazy chunk, so these were build failures `nifra check` passed. Type
positions (`typeof import("x")`, `import("x").Pool`) and computed specifiers are not followed. A
removed package imported dynamically is reported too.
