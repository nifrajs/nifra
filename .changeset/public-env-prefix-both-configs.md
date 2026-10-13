---
"@nifrajs/cli": patch
---

With both `nifra.config.ts` and `backend/framework.ts`, `nifra dev` (Vite and Bun pipelines) and `nifra build` take `publicEnvPrefix` from `backend/framework.ts` when `nifra.config.ts` leaves it unset, as they already did for the server options. `nifra check` reads `nifra.config.ts` first, so every command draws the browser environment line from the same value. A `publicEnvPrefix` that is not a string is refused at load, naming the file.
