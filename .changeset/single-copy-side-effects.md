---
"@nifrajs/core": patch
---

The single-copy resolver lets Bun resolve a declared package itself when Bun's own `node_modules` lookup from the importing file already reaches the app's copy. Before, it returned a path for every declared import, and Bun drops a package's `sideEffects: false` pruning for a path a plugin returns. A browser import of one helper from a package entry that also re-exports server modules then pulled in all of them. With `"singleCopy": ["@nifrajs/*"]` (or `true`), `import { canonical } from "@nifrajs/web"` in browser code made `nifra dev` refuse `node:fs`, `node:path` and `node:stream`. Imports that would reach another copy are still redirected to the app's.
