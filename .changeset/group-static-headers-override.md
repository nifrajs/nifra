---
"@nifrajs/core": minor
"@nifrajs/middleware": minor
---

A static response header a group declares replaces the value its enclosing scopes declared for that name, on the group's routes. A value the route sets itself still wins. `securityHeaders()` takes its configuration into its plugin name, so a group's `use(securityHeaders({ ... }))` with a different configuration applies over the app's on the group's routes, where it was skipped as a repeat; the same configuration applied twice is still a no-op.
