---
"create-nifra": patch
---

The API and batteries starters' `start` script runs with `NODE_ENV=production` and `NIFRA_ALLOW_MEMORY_RATE_LIMIT=true`, like a site's built `start`. It ran the TypeScript source with no `NODE_ENV`, so it ran in development mode. With `--auth`, better-auth then fell back to its development secret when `BETTER_AUTH_SECRET` was empty, where production refuses to start.
