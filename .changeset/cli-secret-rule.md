---
"@nifrajs/cli": minor
---

feat(cli): `nifra check` reports credentials in browser code

NF-C032 is an error for what looks like a credential in a route's frontend half, `frontend/`,
`shared/` or `public/`, with the scanner `nifra build` runs. `nifra build` reads `secretExemptions`
from `nifra.config.ts`, and `nifra check` honors the same entries when they are written as literals.
