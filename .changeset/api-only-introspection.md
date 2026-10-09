---
"@nifrajs/cli": minor
---

A directory with `backend/app.ts` and no web config is read as an API-only app by `nifra routes`, `nifra context`, `nifra openapi` and `nifra mcp`. They load `backend/app.ts` alone, without an adapter. `nifra context` names the app API-only and lists no pages. `nifra routes --modes` says it has no page routes to read. The tools, resources and prompts the backend declares are listed by `nifra mcp`, and the `nifra://routes` and `nifra://openapi` resources answer. `nifra dev` and `nifra build` still need a web config; their error names the API-only reading when `backend/app.ts` exists.
