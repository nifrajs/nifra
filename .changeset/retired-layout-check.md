---
"@nifrajs/cli": major
---

`nifra check` fails with NF-C038 on an app still on the retired root layout: a root `backend.ts` or `framework.ts` in an app with `routes/` or a config, or, elsewhere, one that exports `backend` or `adapter`. No contract gate reads those files there, so the check no longer passes without running them. The finding names `nifra migrate layout`. A `backend.ts` module in a project that is not a routed app, and exports no `backend`, is no longer read as the retired layout by any command. NF-C035 no longer reports an API-only app, which has no page routing for `/api` to fall into.
