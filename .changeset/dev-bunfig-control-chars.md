---
"@nifrajs/cli": patch
---

`nifra dev --bun` now carries a bunfig string holding a newline, tab or other control character into the dev server's config intact; such a value used to make the generated config unparseable.
