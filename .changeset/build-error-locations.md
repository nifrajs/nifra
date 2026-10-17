---
"@nifrajs/web": patch
"@nifrajs/cli": patch
---

`nifra build`, `nifra dev` and `buildClient`/`buildServer` print each bundler error with its file, line and column and the source line, where they printed the message alone. The message that `buildServer` throws without a client entry now names the `client` option.
