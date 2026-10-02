---
"create-nifra": major
---

feat(create-nifra)!: a site scaffold picks one deploy target

- `--target bun|node|deno|cloudflare|vercel` (default `bun`) chooses where the site deploys.
  `--deploy` is refused with that name.
- `--docker` adds a Dockerfile and `.dockerignore` for `bun` or `node`.
- The scaffold carries no hand-written server entry or build script. `nifra build` generates the
  target's entry, and `nifra.config.ts` exports the `target` (`nifra target <t>` switches it).
- Only the target's own config file is written (`deno.json` for Deno, `wrangler.toml` for
  Cloudflare), plus `start` / `deploy` scripts for it. `--ci` deploys the chosen target.
