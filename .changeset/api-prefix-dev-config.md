---
"@nifrajs/cli": patch
"create-nifra": patch
---

NF-C035 reads `apiPrefix` where each consumer reads it: `backend/framework.ts` for the server entry `nifra build` generates, and `nifra.config.ts`, which `nifra dev` loads when it exists. An `apiPrefix` that `backend/framework.ts` sets and `nifra.config.ts` does not export is now reported at `nifra.config.ts`, since `nifra dev` then serves the backend nowhere while production serves it; `export *` from `./backend/framework` counts as exporting it. The finding is a warning instead of information, and `nifra fix --code NF-C035` adds the re-export to `nifra.config.ts` along with the mount. A new site scaffold states `export const apiPrefix = ""` in `backend/framework.ts`, so it starts without the warning.
