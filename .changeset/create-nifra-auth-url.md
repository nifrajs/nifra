---
"create-nifra": patch
---

`bun create nifra --db <preset> --auth better-auth` now writes the `BETTER_AUTH_URL` its template's dev server actually uses into `.env.example`: `http://localhost:4321` for the site template (`nifra dev`), `http://localhost:8787` for the ISR template (`wrangler dev`) and `http://localhost:3000` for the API and batteries templates. Before, every template got `http://localhost:3000`, so a site copied from `.env.example` had better-auth checking request origins against the wrong port.
