---
"@nifrajs/web": minor
---

fix(web): the client build fails on a Node built-in the bundler left as an external import

Bun keeps a dynamic `import("node:fs")`, and a bare built-in such as `import("fs/promises")`, as an
import in a browser chunk instead of bundling a polyfill. The import shipped and failed in the
browser, and the Node built-in guard passed it because the module was in no output. The guard now
reports such an import in the chunk its importer landed in, with the import chain, and names a bare
built-in with its `node:` prefix.

The Vite pipeline gives the same result: `viteBareBuiltinExternal()` from
`@nifrajs/web/plugins/vite-leak-guard` keeps a bare built-in named instead of letting Vite replace it
with an empty stub, so the guard fails the build there too. A package of the same name the app
installed (`events`, `buffer`) still resolves to that package. `buildClientVite` adds the plugin.
