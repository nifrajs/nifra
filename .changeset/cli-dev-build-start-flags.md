---
"@nifrajs/cli": patch
---

`nifra dev`, `nifra build` and `nifra start` now read `--flag=value` as well as `--flag value` (`nifra build --target=vercel` builds for Vercel), and refuse an unknown flag, a stray argument or a flag missing its value with exit code 1 instead of ignoring it. Before, `nifra build --target=vercel` or a mistyped `--targt vercel` built the default target and exited 0. `--help` after one of these commands now prints the usage instead of starting the command.
