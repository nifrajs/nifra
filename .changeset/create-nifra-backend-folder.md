---
"create-nifra": major
---

feat(create-nifra)!: every template keeps its server code in `backend/`

- The `api` and `batteries` templates keep their app in `backend/` (`backend/app.ts`,
  `backend/index.ts`), and `backend/app.ts` exports `backend` and `type Backend`, so `nifra contracts`
  and `nifra sdk` find it without configuration.
- `--db` writes its data layer to `backend/db/` (the Drizzle config, scripts and `.gitignore` entries
  point there), and `--auth` writes `backend/auth.ts`. Every module a scaffold writes is in a zone,
  so a site's route backends can import them.
- The `isr` template's Workers entry and local Bun server are `backend/worker.ts` and
  `backend/dev-server.ts`.
