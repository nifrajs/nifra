---
"@nifrajs/cli": minor
"@nifrajs/web": patch
---

An app run by `nifra dev` and `nifra build` names its sign-in cookies for kept pages by exporting
`keepAlive` from `backend/framework.ts`, like the other `createWebApp` options there. The dev server,
the generated server entry, the static prerender, `nifra mcp`'s render tool and the hydration gate all
pass it to `createWebApp`, and a value of the wrong shape is refused at load. The
`NIFRA_KEEPALIVE_IDENTITY_COOKIE` report and `nifra doctor` point at that export.
