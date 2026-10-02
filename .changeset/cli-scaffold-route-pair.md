---
"@nifrajs/cli": minor
---

`nifra_scaffold` returns a route pair: the page, typed through its generated `./+types` module, and
its `.backend.ts` half with the loader and its `loaderOutput` schema. With `write`, it creates both
files (refusing when either exists) and generates the route's types. Vanilla pages declare
`hydrate = false` and their `islandScripts` in the backend half.
