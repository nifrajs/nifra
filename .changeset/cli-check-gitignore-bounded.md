---
"@nifrajs/cli": patch
---

fix(cli): `nifra check` respects `.gitignore` and bounds the MCP result

Two fixes so `nifra check` (and the `nifra_check` MCP tool) can't drown in a repo full of generated apps:

- **Scanner honours `.gitignore`** — `walkSource` now filters candidates through one batched
  `git check-ignore`, so a gitignored generated/build tree isn't walked. A repo that gitignores, e.g., a
  238-app generated-output dir went from a **52 MB** check result to ~130 KB. Degrades to the built-in
  ignore list (node_modules/dist/…) when there's no git repo — never throws.
- **`nifra_check` MCP tool caps its output** — `collectCheckResult` gains `maxDiagnostics` (the tool sets
  100) and reports `truncated: { shown, total }`, so a huge project can't emit an MCP message large enough
  to break the stdio transport (`-32000: Connection closed`). `ok` still reflects the FULL set; the CLI
  terminal / `--json` output stays unbounded.
