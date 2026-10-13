---
"@nifrajs/cli": minor
---

NF-C035 also reads app modules that call `createWebApp` from `@nifrajs/web` themselves. A call that mounts a backend (`api`) with no `apiPrefix`, or with a string different from the `apiPrefix` `nifra dev` reads from the framework config, is reported at the call with both values: production then serves the backend somewhere `nifra dev`, end-to-end runs under it and the rest of `nifra check` never exercised. An `apiPrefix` imported from `backend/framework.ts` or `nifra.config.ts` matches by construction; options built from a spread or a variable, or a value the scan cannot read, are not reported.
