---
"@nifrajs/cli": minor
---

`nifra upgrade 5.9.0` rewrites the code the release changes, on the syntax tree, with the project's TypeScript (or the CLI's own):

- each `servePublicDir(...)` call becomes the runtime's `serveStatic(...)` with options that keep its answers, and its import moves;
- an object or array that `@nifrajs/node`'s `static` takes is wrapped in `serveStatic(...)`;
- `signals` on `@nifrajs/node`'s and `@nifrajs/deno`'s `serve()` becomes `gracefulSignals`.

A site it cannot rewrite whole, such as options built in another variable or a `cache.hashed` policy with no counterpart, is listed with its line and what to write. When no TypeScript resolves, the upgrade refuses before it writes anything.
