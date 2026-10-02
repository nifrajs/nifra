---
"@nifrajs/web": patch
---

fix(web): every pipeline names backend code that reaches the browser, however it is imported

- A side-effect import of backend code (`import "../backend/x.ts"`) fails the Bun client build with
  the module and the import chain that reached it, even when the bundler drops the import.
- A module marked backend-only fails the Vite client build even when it was inlined into no chunk.
- The server build sees imports of modules the bundler later dropped.
- The Vite dev server classifies what an alias, a tsconfig path or a package export resolves to, and
  names the importing file in the error.
- `createViteDevServer(...).stop()` no longer hangs when it is called while Vite is still
  pre-bundling dependencies for the first time.
