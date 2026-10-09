---
"@nifrajs/cli": patch
---

Capability provenance now follows imports into a workspace package that lives beside the app, as in an `apps/web` + `packages/*` monorepo. Before, a route reaching a forbidden import through such a package reported clean, because the walk stopped at any module outside the app directory. Installed packages under `node_modules` outside the app are still not entered.
