---
"@nifrajs/coding-agent": patch
"@nifrajs/pi": patch
---

The `test` verification gate runs the project's suite with `bun test`. `--verify-after-turn test` in `nifra-agent` and the Pi extension's `nifra_test` tool used to run a `nifra test` command that does not exist, so the gate failed on every project.
