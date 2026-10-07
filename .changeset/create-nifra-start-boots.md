---
"create-nifra": patch
---

fix(create-nifra): `bun run start` on a new site boots the built app instead of exiting. A `nifra build` output runs as production, where the starter's in-memory rate-limit store refuses to start unless `NIFRA_ALLOW_MEMORY_RATE_LIMIT=true`. The bun, node and deno `start` scripts now set it, as the Cloudflare one already did, because a local run is a single process. A `--docker` scaffold's `deploy` script sets it for the one container it runs. The image itself does not, so a deployed replica set still needs a shared store or an explicit opt-in.
