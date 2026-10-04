---
"create-nifra": patch
---

`create-nifra` refuses a destination that already holds files unless `--force` is given, for every template. Before, the site template scaffolded into such a directory and replaced its `.gitignore`, `AGENTS.md`, `CLAUDE.md` and agent/MCP config files. An existing empty directory is now accepted without `--force`, and `bun create nifra . --force` names the project after the current directory instead of rejecting the name `.`.
