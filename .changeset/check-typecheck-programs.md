---
"@nifrajs/cli": minor
---

`nifra check` typechecks every project `tsconfig.json` references, each as its own program, so a solution-style tsconfig (`"files": []` plus `references`) no longer passes having read nothing. A project whose code is split across sibling configs names them in `nifra.check.json` as `"tsconfigs": ["tsconfig.json", "tsconfig.server.json"]`; the list replaces the default, is echoed in the human, JSON and MCP results, and a listed config that does not exist fails the typecheck. The zone coverage check reads the union of the programs, and an error two programs both report is shown once.
