---
"@nifrajs/cli": minor
---

`backend/framework.ts` takes `live`, the app's live runtime (re-export it from `nifra.config.ts` when the app has both): `nifra dev` serves its socket and `nifra build` bakes its socket and load paths into the client.
