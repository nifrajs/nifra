---
"@nifrajs/web": minor
---

`/llms.txt` and `/llms-full.txt` are now off unless `createWebApp({ llmsTxt: true })`. Both are public and unauthenticated. They listed every page route and every backend route mounted over HTTP, admin and internal ones included, and the full text added each route's request and response schemas. An app that serves them on purpose sets `llmsTxt: true`. `publishLocalGuidelines` still controls whether `AGENTS.md` is included.
