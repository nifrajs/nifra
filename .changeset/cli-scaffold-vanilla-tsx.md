---
"@nifrajs/cli": patch
---

`nifra scaffold` and the `nifra_scaffold` tool write a vanilla page as `routes/<name>.tsx`. They wrote `routes/<name>.ts`, which route discovery does not read as a page, so the app failed to load with `"<name>.backend.ts" has no frontend half`. The page needs no JSX to use the `.tsx` extension.
