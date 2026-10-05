---
"@nifrajs/cli": patch
---

`nifra migrate layout` puts a module only route pages use in `frontend/` even when a generated
`server-manifest.ts` imports every page. The server renders a page it imports rather than running it,
so the server's reach stops at route pages.
