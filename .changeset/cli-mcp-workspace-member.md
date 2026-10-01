---
"@nifrajs/cli": minor
---

feat(cli): `nifra mcp` started at a package-manager workspace root serves its nifra app.
When neither the spawn directory nor any ancestor is a nifra project, the server reads the spawn
directory's `package.json` `workspaces` (the array form or `{ packages }`), and adopts the one member
that depends on `@nifrajs/*` or has a `nifra.config.ts`. The root's source reads `workspace`. With
several nifra members it adopts none, and project tools refuse with a message naming each member to
pass to `nifra mcp <dir>`. A client workspace folder that is a workspace root offers its nifra member
the same way. An explicit `nifra mcp <dir>` is never redirected, and `node_modules` is never a member.
