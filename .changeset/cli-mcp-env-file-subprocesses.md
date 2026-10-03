---
"@nifrajs/cli": patch
---

`nifra mcp --env-file <path>` values now reach the processes its tools start: `nifra_run` (one-off and `warm`), `nifra_render`, `nifra_ws`, `nifra_hydrate`, `nifra_test` and the `nifra_db_*` tools see them, as the app's own tools and the tools that load the app do.
