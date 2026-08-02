---
"@nifrajs/web": patch
"@nifrajs/cli": patch
---

Harden the dev-only diagnostics endpoint and the agent-facing reads of it. The dev server now binds to `127.0.0.1`, answers `/__nifra/last-error` with an identity header, and resolves source paths so the codeframe stays inside the project. The Vite dev server serves that endpoint at parity with the Bun one. `nifra_explain` and `nifra_inspect` validate the target port, time out, cap the response size, and only return a body from a verified nifra endpoint - so pointing them at an unrelated local service returns a clear error instead of that service's response.
