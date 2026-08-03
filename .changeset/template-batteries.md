---
"create-nifra": minor
---

The batteries-included backend starter is now `--template batteries` (background jobs, TTL cache, blob storage, cursor pagination on top of the `api` template), and it ships in the published package. `--template fullstack` no longer exists; asking for it explains the split: `site` is the full-stack (frontend + backend) template, `batteries` is the API starter. The README now documents all four templates, and the scaffolded `backend.ts` states its root-path convention: the CLI resolves `backend.ts` (like `routes/`, `framework.ts`, `nifra.config.ts`) from the project root - only that entry file is pinned there; merged feature modules can live anywhere.
