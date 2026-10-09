---
"@nifrajs/cli": patch
---

`nifra check` reads every file a build loads, not only TypeScript. `.jsx`, `.svelte` and `.vue` files, and `.js`/`.mjs`/`.cjs` files under `routes/`, `frontend/`, `shared/` or `backend/` (or with a zone suffix), now get the source rules: a `.jsx` or `.svelte` route importing `pg`, reading `process.env.DATABASE_URL` or carrying a secret key passed before. Svelte and Vue files are scanned as their `<script>` blocks, with the whole file read where markup can hold code, and this works on a TypeScript 7 install too. JavaScript files outside a zone (bundler configs, scripts) stay out of the scan.
