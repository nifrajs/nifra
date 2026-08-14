---
"@nifrajs/cli": minor
"@nifrajs/web": minor
---

`nifra dev` gains `--allow-duplicate-identity`, which downgrades the Vite dev server's startup
identity-parity check from a hard failure to a loud warning. The check catches two physical copies of
an identity-sensitive package (React, the framework adapter, `@nifrajs/core`) resolving in one process,
which reliably breaks hydration and framework context - so it stays a hard stop by default, and
`nifra build` never honors the flag. But when the duplicate originates in a linked sibling repo you
cannot fix in the moment, the previous behavior took the dev server down with no way to keep working.
With the flag, the server prints the same finding detail (packages, versions, resolved paths) and a
reminder that duplicate identity can still corrupt hydration, then continues at exit 0. The web option
`createViteDevServer({ allowDuplicateIdentity: true })` exposes the same escape programmatically.
