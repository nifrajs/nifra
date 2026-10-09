---
"@nifrajs/cli": minor
---

`nifra migrate layout` migrates an API-only app: one that declares `"nifra": { "kind": "api" }`, or has no web config, no `routes/` and a `backend.ts`. Only `backend.ts` moves, to `backend/app.ts`, with its own relative imports and the imports that name it. Nothing is split or zoned. The migration adds `backend` to tsconfig `include` and `.nifra/` to `.gitignore`, and adds `"nifra": { "kind": "api" }` to package.json when the app declares no kind: the dry run lists it, `--write` writes it. Web config without `routes/` stops the migration with the choice to make, and so does a declared API kind beside web config. The JSON result carries `mode: "web" | "api"`.
