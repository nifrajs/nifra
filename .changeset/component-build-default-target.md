---
"@nifrajs/web": patch
---

`buildServerComponents` and `devServerComponents` called without a `target` now compile for Bun, the target the build assembles and `nifra build` defaults to. They compiled for Node and then assembled a Bun server, so a server module that imports a `bun:` built-in was refused as "unsupported on node".
