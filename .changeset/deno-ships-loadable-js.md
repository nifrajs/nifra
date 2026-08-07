---
"@nifrajs/deno": patch
---

Fix: `@nifrajs/deno` is now importable from npm under Deno.

The package shipped only TypeScript source, with every export condition pointing at
`./src/index.ts`. Deno refuses to strip types for any file resolved under `node_modules`
(including its own npm cache), so `import { serve } from "npm:@nifrajs/deno"` - the form the
README documents - failed with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` on every install.

It now ships built `dist/index.js` + `dist/index.d.ts` and resolves `types`/`default` there, the
same layout as `@nifrajs/node`. No API change: `serve()`, `ServeOptions`, and `DenoServer` are
unchanged, and source maps still point at the shipped `src/`.
