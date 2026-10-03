---
"@nifrajs/cli": patch
---

`nifra mcp` runs no project code in its own process and keeps none of the project's `.env`. The tools that load the app (`nifra_context`, `nifra_routes`, `nifra_check`, `nifra_openapi` and the rest), the routes and OpenAPI resources, and the tools, resources and prompts the app declares on its backend run in a fresh subprocess per call, started in the project's directory. Each call sees the project's current code and its `.env`, wherever the client started the server, and a config or backend that exits or hangs fails only that call. `nifra_run`, `nifra_render`, `nifra_ws` and `nifra_hydrate` also start their processes in the project's directory. A server that Bun started with `.env` values serves from a copy of itself that never loads them; values set in the environment and `--env-file` values are kept. A call that loads the app costs one process start, tens of milliseconds, more when the config imports heavy plugins.
