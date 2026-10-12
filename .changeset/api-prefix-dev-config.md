---
"@nifrajs/cli": patch
"create-nifra": patch
---

With both `nifra.config.ts` and `backend/framework.ts`, every command takes `apiPrefix`, `apiStrip`, `mounts`, `csp`, `nonce`, `serverComponents` and `use` from `backend/framework.ts` when `nifra.config.ts` leaves them unset, and validates them there. Before, `nifra dev` loaded only `nifra.config.ts` and the server entry `nifra build` generates imported only the options it set, so an `apiPrefix` set in `backend/framework.ts` alone served the backend nowhere over HTTP. NF-C035 reads the same merged value, reports a missing `apiPrefix` as a warning instead of information, and `nifra fix --code NF-C035` adds the mount to `backend/framework.ts`. A new site scaffold states `export const apiPrefix = ""` in `backend/framework.ts`, so it starts without the warning.
