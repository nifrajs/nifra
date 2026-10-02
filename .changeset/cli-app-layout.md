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

`nifra check` holds source to the same zones the builds enforce, with the same classifier
(`@nifrajs/web/zones`). NF-C004 follows browser code - a route's frontend half, `frontend/` and
`shared/` - to Node and Bun built-ins, server packages, backend modules and the `backend-only` marker,
naming the chain; a `*.fn.ts` module counts as its stub. NF-C028 reports a zoned file importing one in
no zone, backend code importing frontend code, and shared code importing anything but shared code.
NF-C029 reports browser code reading a private environment variable, honouring a literal
`publicEnvPrefix` in `backend/framework.ts`. NF-C005 names the retired `@nifrajs/web/server-only` and
`@nifrajs/web/plugins/vite-server-only` imports with their replacements. A route's `x.backend.ts` half
counts as a route file for manifest drift (NF-C012), and NF-S002 grades severity by zone.
