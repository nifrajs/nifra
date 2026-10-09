---
"@nifrajs/cli": patch
---

`nifra review` files every built-in check code under its own check. Codes added after NF-C023 fell through to `configuration`, so a private environment read or a credential in browser code (NF-C029, NF-C032) and the output-schema data guard (NF-C030, NF-C031, NF-C033) were reported as configuration rather than security. Route-table codes now report under `route-boundary`, zone imports under `server-boundary`, and contract visibility (NF-C039) under `contract-witness`.
