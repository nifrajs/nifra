---
"@nifrajs/cli": patch
---

`nifra_run` and `nifra_ws` return as soon as the answer is written. An app that keeps a handle open at load, such as a database pool or an interval, made each call wait out the 30-second child timeout.
