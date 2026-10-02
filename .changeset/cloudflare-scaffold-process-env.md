---
"create-nifra": patch
---

Cloudflare scaffolds (a site with `--target cloudflare`, and the ISR template) declare `compatibility_date = "2025-04-01"`, the first date at which `nodejs_compat` fills `process.env` from the project's variables, so `NIFRA_ALLOW_MEMORY_RATE_LIMIT` reaches the starter's rate limit. Their local-only commands (`bun run start` for the site, `bun run dev` for ISR) set it for the one local process; a deploy still refuses to start until the variable is set.
