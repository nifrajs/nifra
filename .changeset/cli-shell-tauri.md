---
"@nifrajs/cli": minor
---

`nifra shell tauri` adds a Tauri 2 shell to an existing app: `frontend/shell-transport.ts` and a `src-tauri/` project whose build runs `nifra build --target static --transport` into `dist-shell/` and whose content security policy allows the server's origin and socket. The window opens hidden and shows on the page's first paint (a three second timer shows it if none is reported), so there is no blank window while the web view starts. It writes files only, skips any that exist unless `--force`, and leaves `package.json` and `nifra.config.ts` alone. `--mobile android|ios|all` then runs `tauri android init` and `tauri ios init` with the project's Tauri CLI and reports each platform. The command is in the command catalog (CLI only).

`nifra build` and `nifra dev` take `--transport <module>` for one run, ahead of `transport` in the config, so one app can ship a web build and a shell build.
