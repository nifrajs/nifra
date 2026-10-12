---
"@nifrajs/cli": patch
---

`nifra verify` prints a line on stderr as each gate starts and finishes, with the gate's time, and the summary shows each gate's time and the total. A long run shows which gate it is on, and a slow gate can be found. The JSON result (`--json`, the `nifra_verify` MCP tool) gains `durationMs` on each gate that ran and on the result.
