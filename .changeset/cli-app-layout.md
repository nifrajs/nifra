---
"@nifrajs/cli": major
---

feat(cli)!: `backend/app.ts` and `backend/framework.ts`, and `nifra migrate layout`

The CLI reads the backend from `backend/app.ts` and the render adapter from `backend/framework.ts`.
An app that still has a root `backend.ts` or `framework.ts` is refused with the command that moves it.

`nifra migrate layout` moves an app onto the zoned layout: it splits each route into `x.tsx` and
`x.backend.ts`, folds `_middleware.ts` into `_layout.backend.ts`, moves the root files under
`backend/`, places every other module in `frontend/`, `backend/` or `shared/` by who imports it, and
rewrites the imports. It is a dry run until `--write`, and it lists what it could not decide - a
helper both halves need, a page that reads a server export at runtime, a path named in a string.
