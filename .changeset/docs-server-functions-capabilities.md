---
"@nifrajs/cli": patch
---

Documents server functions and effect provenance.

Two features shipped without a page. Server functions span seven packages and had none at all, and the
effect provenance firewall - now armed in every template - emits a finding (`unconfined-write-reach`)
whose fix is structural and was explained nowhere outside code comments.

Both pages join the docs corpus the MCP server and `nifra_docs` search read from, so an agent finds them
too.
