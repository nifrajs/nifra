---
"@nifrajs/cli": patch
---

fix(mcp): `nifra mcp` re-reads the nifra version the project installs on every tool call, not only at startup. After an upgrade during a session, the version-sensitive tools (`nifra_check`, `nifra_types`, `nifra_docs`, `nifra_example`, `nifra_assure`, `nifra_contracts`) refuse with the restart fix instead of answering for the release the server started with.
