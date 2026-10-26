---
"@nifrajs/cli": patch
"@nifrajs/core": patch
"@nifrajs/image": patch
"@nifrajs/node": patch
"@nifrajs/proxy": patch
"create-nifra": patch
---

The modules a package carries as its own copy of another package's file (the static-file open helper, the agent-file generators, the Node-stream hand-off, and core's helpers inside the Node and Deno adapters) are generated from one source each, under a header naming it. No API or behavior change.
