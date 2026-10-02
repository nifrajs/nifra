---
"@nifrajs/cli": minor
---

`nifra migrate layout` also moves an app off the retired names and reports what the data guard needs:

- each `x.server.ts` module moves under `backend/` without the suffix (`lib/db.server.ts` becomes
  `backend/lib/db.ts`), and every import of it is rewritten; one a route frontend still imports at
  runtime, or whose new path is taken, is reported instead;
- `@nifrajs/web/server-only` imports become `@nifrajs/web/backend-only`, and `ServerOnly` imported from
  `@nifrajs/web` becomes `BackendOnly`;
- an import of `@nifrajs/web/plugins/vite-server-only` is reported for removal;
- a loader or action that returns data without `loaderOutput` / `actionOutput` is reported, since the
  server refuses that data.
