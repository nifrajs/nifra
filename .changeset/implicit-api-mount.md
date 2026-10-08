---
"@nifrajs/web": major
"@nifrajs/cli": major
---

`createWebApp` serves `api` over HTTP only at the `apiPrefix` it is given; without one the backend is loader-only (`ctx.api`) and a request under `/api` reaches page routing. 4.x mounted it at `/api` by default. `nifra dev`, `nifra build`, `nifra routes` and the page-under-mount check (NF-C027) follow the same rule for `backend/framework.ts`.

`nifra check` reports a `backend/framework.ts` that sets no `apiPrefix` while `backend/app.ts` exports a backend (NF-C035, info), and `nifra fix --code NF-C035` adds `export const apiPrefix = "/api"` to keep the 4.x mount. Set `apiPrefix = ""` to state that the backend is loader-only.
