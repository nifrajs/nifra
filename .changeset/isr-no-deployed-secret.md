---
"create-nifra": patch
---

The ISR starter no longer ships `REVALIDATE_SECRET = "dev-secret"` as a `[vars]` entry in `wrangler.toml`, which `wrangler deploy` published as the production purge token. The deployed Worker now answers 404 on `/__nifra/revalidate` until `bunx wrangler secret put REVALIDATE_SECRET` sets a real one; `bun run dev` passes the local value with `--var`. An app scaffolded earlier should delete that `[vars]` entry and set the secret.
