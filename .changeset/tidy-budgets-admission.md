---
"@nifrajs/core": patch
"@nifrajs/budget": patch
"@nifrajs/middleware": patch
---

Move request-deadline mechanics to the dependency-free `@nifrajs/core/budget` subpath while keeping
`@nifrajs/budget` as a compatible re-export. Harden adaptive admission across ESM runtimes, reserved
capacity, disconnected queued requests, and invalid capacity evidence.
