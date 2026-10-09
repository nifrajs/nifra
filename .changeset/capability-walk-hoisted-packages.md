---
"@nifrajs/cli": patch
---

Capability provenance follows an installed package hoisted above the app (a monorepo's root `node_modules`) the way it already followed one in the app's own `node_modules`. A route reaching a forbidden import through a hoisted package reported clean.
