---
"@nifrajs/cli": patch
---

`nifra_types` answers for every published package.

`@nifrajs/deno`, `@nifrajs/content` and `@nifrajs/workers` contributed nothing to the type index the
MCP tool reads. They ship `files: ["src"]` and point `types` at `./src/index.ts`, which is right for a
package resolved by Deno, workerd or Bun, while the index only ever looked for a built `dist/*.d.ts`.
Asked about `serve`, `defineCollection` or `createWebSocketHub`, an agent got nothing back and wrote
the API it guessed instead.

Their declarations are now emitted from source, per file and without a type checker, so the index
starts where a consumer's resolver starts either way. Signatures are declarations, not implementations
pasted in; the 1,545 entries already there are byte-identical.

The `--check` gate could not have caught this - it compares the regenerated file against the committed
one, and a package missing from both matches forever. So `gen:llms` now fails when a published package
contributes no types at all, which also turns the quietest failure here into a loud one: run it without
building first and the file used to be rewritten with almost nothing in it.
