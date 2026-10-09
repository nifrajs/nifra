---
"@nifrajs/cli": patch
---

`nifra mcp` exits when its client closes stdin, also after a `warm: true` call to `nifra_run` or `nifra_render`. The warm worker those calls start used to keep the server process alive after the session ended. The server now stops every warm worker and starts no new ones once stdin closes.
