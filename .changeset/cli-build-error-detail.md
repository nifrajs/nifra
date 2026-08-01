---
"@nifrajs/cli": patch
---

`nifra build` and `nifra dev` now print the real cause of a failed bundle. When `Bun.build` throws, it raises an `AggregateError` whose own message is a generic "Bundle failed" and whose underlying errors - the unresolved import, the plugin that threw, each with a file and line - were dropped by the CLI's error output. Those causes are now unwrapped and printed, one per line, at every CLI error boundary.
