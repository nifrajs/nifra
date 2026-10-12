---
"@nifrajs/cli": minor
---

`nifra assure --bundle` (and `--strict`) carries an `assurance` gate. Route-assurance findings fail it; before, the bundle never evaluated the route policy, so a failing policy could still come back green. A declared response or error schema that no `responseContract()` enforces is a warning there, so `--strict` refuses a green verdict while any route is typed-only or warn-only.

`nifra levels` names the typed-only routes and says where the plugin has to go: on the server that registers them, before them. When `responseContract()` already covers other routes, the reason says so, instead of advising an install that has already happened. It also prints the baseline rule that makes L1 require enforcement.

The static route scan follows one import hop: a module that builds its server with a local helper (`newServer().get(...)`, where `newServer` comes from a project file that calls `server()`) is read as a backend. A route that still has no static provenance coverage now says why: which file appears to register it on a server the scan cannot identify, or that no file registers it with a readable path. Either way the reason points at `capabilities.provenance.routeModules`.
