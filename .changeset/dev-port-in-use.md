---
"@nifrajs/web": patch
---

`nifra dev` names a port collision instead of dying inside `node:events`.

Starting the dev server while an earlier one still holds the port produced a raw internal stack from
Node's event emitter and killed the new process in the background. The old server kept answering on that
port, so the browser carried on rendering the previous build. The symptom that reaches the developer is
not "the port is taken" but "my edits stopped reaching SSR" - which reads as broken HMR or a stale module
graph and sends you looking anywhere but at the one process that never started.

Binding now fails with the port named, the stale-output consequence spelled out, and both fixes given
with the port already substituted: free it, or take the next one. Vite is torn down on that path, because
by the time the bind is attempted its watchers and dep optimizer are holding the event loop open - a
handled error alone would leave the process printing a diagnosis and then hanging on it, which looks
exactly like a dev server still starting up. Other bind failures pass through unchanged rather than
inheriting port-collision advice that would not apply.
