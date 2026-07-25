---
"@nifrajs/cli": patch
---

The release's version script regenerates the llms corpora, so the "Version Packages" PR can pass CI.

`types.json` stores exported signatures verbatim, including core's `VERSION` as the literal type
`export declare const VERSION: "2.2.0"`. Bumping the version rewrote that constant and regenerated
`api-reference.md` and the LLM cards, but not the corpora - so every Version PR failed `check:llms` on a
stale `types.json`, and since Release only publishes after CI concludes successfully, nothing could
ship.
