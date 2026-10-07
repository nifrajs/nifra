---
"@nifrajs/web": patch
---

feat(web): in development (`NODE_ENV=development`, which `nifra dev` sets), the data guard logs the paths of fields a loader, action or server function returned but its output schema does not declare, once per distinct set. Paths only, never values; array indices collapse to `*`. Production behavior and cost are unchanged.
