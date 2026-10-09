---
"@nifrajs/cli": patch
---

A hydration run (`nifra assure --hydration`, `nifra replay`) that times out or is cancelled now stops every process the project's code started, not only its own child, so it ends at its timeout instead of waiting on a process still holding its output. Ctrl+C in a terminal still stops the run.
