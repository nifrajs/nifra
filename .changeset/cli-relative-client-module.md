---
"@nifrajs/cli": patch
---

A `clientModule` given as a relative path (a local client entry, e.g. `./src/client.tsx`) now works in both `nifra dev` and `nifra build`. It is resolved to an absolute path when the framework config loads, so the generated client entry - which dev and build write into different directories - resolves it identically in both phases instead of loading in one and breaking in the other. A bare or package specifier (`@nifrajs/web-react/client`) is location-independent and unchanged.
