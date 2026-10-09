---
"@nifrajs/cli": patch
---

A cancelled `nifra check` (an MCP cancel, or Ctrl+C) now stops every process its typecheck started, not only the `tsc` entry, so it ends at once instead of waiting for a compiler process still holding its output. Ctrl+C in a terminal still stops the check.
