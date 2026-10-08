---
"@nifrajs/cli": patch
---

`nifra dev` on Bun applies the `package.json` single-copy declaration (`"nifra": { "singleCopy": [...] }`) to the browser bundle, as `buildClient` does, so a linked package with its own copy of a declared package loads the app's copy without a `clientPlugins` entry. An app that also lists `singleCopyPlugin()` gets that instance in the resolver's place, once.
