---
"@nifrajs/cli": minor
---

`nifra migrate layout` follows imports through tsconfig `paths` and `baseUrl` and package.json `imports`, so a module reached only through an alias is zoned and moved like any other. An alias import of a moved module is rewritten through the same alias, keeping its style (extension, index), when one of that alias's targets covers the new location; otherwise it is left as written and reported. The config's `clientModule` and `componentPipeline.entries` paths are entries too: `clientModule` and `entries.client` are browser code, `entries.ssr` and `entries.rsc` server code, and each path is rewritten when its module moves. A specifier that names no installed package, built-in or app file is reported instead of skipped.
