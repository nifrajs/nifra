---
"@nifrajs/cli": minor
---

`nifra dev`, `build`, `start` and `check` run through the project's own `@nifrajs/cli` when they are
started from another install, such as a global or linked CLI, at any version: the app then loads one
`@nifrajs/core`. `NIFRA_LOCAL_CLI=0` runs the CLI as invoked. When the project installs no CLI of its
own and resolves another `@nifrajs/core` than the running CLI, the command names both paths before it
starts. `nifra mcp` hands a session to the project's CLI on the same rule.
