---
"@nifrajs/cli": patch
---

`nifra upgrade` moves the fixed group's pins in `overrides` (npm and Bun, nested ones included), `resolutions` (Yarn and Bun) and `pnpm.overrides` along with the dependency fields, refusing a rollback there the same way, and rewrites each pin only inside the field it was read from. An override also counts toward the installed version that picks the recipes to run and toward the mixed-versions report in `nifra doctor` and `nifra check`. Another version pinned outside package.json is listed with its line and never edited: MCP configs such as `.mcp.json`, Dockerfiles and compose files, CI workflows, and lockfiles other than the workspace's own, with a note to regenerate them. The JSON plan carries them as `strayPins`.
