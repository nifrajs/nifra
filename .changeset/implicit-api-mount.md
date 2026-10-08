---
"@nifrajs/web": minor
"@nifrajs/cli": minor
---

`createWebApp` warns once in development when `api` is mounted at `/api` because no `apiPrefix` was given: an app that also serves that backend behind its own server gets a second path to it there. The mount itself is unchanged. `nifra check` reports the same for a `backend/framework.ts` that sets no `apiPrefix` while `backend/app.ts` exports a backend (NF-C035, info). Set `apiPrefix` to `"/api"` to keep the mount or `""` to drop it.
