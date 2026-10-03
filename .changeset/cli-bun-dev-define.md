---
"@nifrajs/cli": patch
---

`nifra dev` on the Bun pipeline applies the `define` from `nifra.config.ts` to the browser bundle and to server rendering, as `nifra build` does. Vue's feature flags reach the dev client, so the "Feature flags ... are not explicitly defined" warning no longer appears. A config `define` entry wins over the same name in the app's own `bunfig.toml`, and a value that is not a string is refused by name.
