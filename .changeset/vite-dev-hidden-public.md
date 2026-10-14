---
"@nifrajs/web": patch
---

`nifra dev` on the Vite pipeline no longer serves hidden files from `public/`. Vite's public middleware served every file there, dotfiles included, so `/.env`, `/.git/config` and `/%2eenv` answered with their contents. A request for a hidden file, or a visible name whose real target is hidden, now goes to the app, as it does in production and on the Bun pipeline. The dev server binds 127.0.0.1 and Vite refuses a foreign `Host`, so the exposure was limited to local processes and the developer's own browser.
