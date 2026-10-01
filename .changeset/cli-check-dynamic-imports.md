---
"@nifrajs/cli": minor
---

fix(cli): `nifra check` follows a literal dynamic `import()` from a route

The server-only import check (NF-C004) treats `import("../lib/x")` with a string-literal specifier
like a static import: from a route module and through its local imports, down to a Node built-in, a
known server-only package or a module marked `@nifrajs/web/server-only`. The client build bundles a
dynamic import's target as a lazy chunk, even from inside a loader, so these were build failures
`nifra check` passed. Type positions (`typeof import("x")`, `import("x").Pool`) and computed
specifiers are not followed. A removed package imported dynamically is reported too.

A `*.server` module is no longer a finding, statically or dynamically imported: the client build
replaces it with an empty module, so it is the boundary the check now recommends alongside `ctx.api`,
and its own imports are not followed.
