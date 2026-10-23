---
"@nifrajs/cli": minor
---

`nifra scaffold hole <route> <name>` (experimental) adds a hole to a partially prerendered route: the page gets the hole's definition, its entry in `boundaries` and a `<Hole>` where its markup ends, and the backend half a loader with its output schema. `--shared`, `--interactive` and `--timeout <ms>` shape the hole, and `--server` makes it show a new React server component. A Vue or Svelte page gets the code to paste. The MCP `nifra_scaffold` tool takes the same options as `hole`, and previews the files unless `write` is set.

`nifra check` reports NF-C053 (error) for a partially prerendered page that calls `getContext()` or `tryGetContext()`, which the shell check refuses. `nifra fix --code NF-C053` moves a read held in one `const`, and the one element that uses it, into a new dynamic hole: the read becomes the hole's loader, with an output schema drafted from its type, and the element its render. A read it cannot move is refused with the reason, and nothing is written.
