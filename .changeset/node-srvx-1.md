---
"@nifrajs/node": patch
---

`@nifrajs/node` depends on srvx 1.0.8 (was 0.12.5) for the lazy `FastResponse` its twinless fallback builds. The adapter's own code is unchanged and its Node suite passes on both versions. Node 20.16 or newer, as before.
