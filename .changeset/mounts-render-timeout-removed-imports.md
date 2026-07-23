---
"@nifrajs/web": minor
"@nifrajs/cli": minor
---

Mount sub-apps and standalone-shaped backends without a `Proxy`; bound the render worker; lint removed imports.

**`mounts` and `apiStrip` on `createWebApp`.** Two shapes previously needed a hand-written ~40-line
`Proxy` around the backend. The auto-mount dispatches the full `/api/v1/forms`, but a backend that also
runs standalone declares its routes without the prefix and lets its own shell supply it - so every
request 404'd inside it. And better-auth is not a `backend` route, so `/api/auth/*` hit the backend and
404'd silently. `apiStrip: true` removes the prefix before dispatch, and `mounts` takes any
`{ path, app: { fetch } }` - so any library exposing its routes in that shape mounts directly, with no
dependency from `@nifrajs/web` on it. Mounts are matched longest-path-first and before the `api`
prefix, so `/api/auth` wins over `/api` regardless of declaration order.

**A layout that exports a `loader` now fails loudly.** Layouts do not run one - only route files do -
and rendering while ignoring the export was the worst possible handling: it looks wired, the page
renders, and the data is simply never there. The error names the file and says where the fetch should
go instead. Running loaders in layouts is a real feature and is not this change.

**`nifra_render` and `nifra_run` can no longer hang.** The cold-path child wrote its result and then
fell off the end of the module without exiting, unlike the warm-worker branch beside it. Loading an
app runs its module side effects, so a database pool, a Redis client, or an interval kept the child's
event loop alive forever while the parent waited on `proc.exited`. The child now exits explicitly, and
both the cold and warm paths carry a 30s timeout as a backstop, reporting the likely cause rather than
hanging.

**A `removed-import` lint in `nifra check`.** `@nifrajs/budget` folded into core in 2.x with no npm
deprecation - `latest` is still 1.13.0, so a `^2` range resolves to nothing and `bun install` fails
workspace-wide with an error naming neither cause nor replacement. The 2.0 WebSocket change has the
same shape: `import "@nifrajs/core/ws"` no longer installs the runtime, and a consuming package kept
it while its whole test suite stayed green and the app could not boot. Both are now caught before
boot, with the replacement named. The WS rule flags only the bare side-effect form, since the module
still exports `websocket` and a rule that fires on correct code gets ignored.
