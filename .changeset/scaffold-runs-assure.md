---
"create-nifra": patch
"@nifrajs/cli": patch
---

A scaffolded project's `check` script runs the assurance gate it ships with, and the dev refusals cover
extensionless modules.

Every template ships an assurance config, and every template's `check` script ran `nifra check` only -
so the policy was shipped, documented, and never executed by the command a project actually runs in CI.
It now runs `nifra check && nifra assure`.

`nifra dev --bun` refuses `.server` and `.fn` modules because Bun's dev bundler takes no plugins and
would ship them whole. The refusal missed a module with no extension at all, which is the one shape a
directory import produces.
