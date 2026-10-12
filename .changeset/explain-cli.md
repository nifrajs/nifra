---
"@nifrajs/cli": minor
---

`nifra explain` brings the `nifra_explain` MCP tool to the command line: `nifra explain "<message>" --stack "<stack>"` prints the diagnostic code, the frame in the app's source with its codeframe, and the cause and fix when nifra recognises the error; with no message it explains the running dev server's latest error. `--json` prints the diagnostic, and the command exits `2` when there is nothing to explain.
