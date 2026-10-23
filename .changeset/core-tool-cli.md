---
"@nifrajs/core": minor
---

`@nifrajs/core/tool-cli` runs tool contracts from a command line: `runToolCli(tools, process.argv.slice(2), { program, capabilities })` maps each top-level input property to a flag, takes `--input <json>` or `--input -` for the whole input, `--dry-run`, `--yes` or `--approve-level <n>` for approval, and `--json` for the result envelope, and resolves to an exit code from `TOOL_CLI_EXIT`. Every call goes through `executeTool`.
