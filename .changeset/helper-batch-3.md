---
"@nifrajs/web": patch
"@nifrajs/node": patch
"@nifrajs/core": patch
"@nifrajs/cli": patch
---

A partially prerendered hole ignores a fill that is an array, as it ignores any other fill that is not an object, so an interactive hole's root never renders one as its props.

`@nifrajs/node` merges a plain render's headers and checks a WebSocket close through generated copies of `@nifrajs/core`'s own functions, which `check:vendored` keeps identical to their source.

`nifra stylex-migrate` reads nested style objects through the CLI's shared record check.
