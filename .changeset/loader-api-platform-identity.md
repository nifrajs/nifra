---
"@nifrajs/core": minor
"@nifrajs/client": minor
"@nifrajs/web": minor
---

feat(web): SSR loader, action and boundary calls through `ctx.api` now carry the page request's
platform identity. A backend reached from a loader sees the visitor's `c.clientIp` (derived under the
page app's `server.clientIp` trust declaration), `c.env` and `c.waitUntil`, so per-visitor rate limits,
audit logs and bindings work during SSR. Headers are never copied: a loader call stays anonymous unless
the loader passes `cookie` or `authorization` itself. `inProcessClient()` / `testClient()` used outside a
render keep dispatching with no platform.

New seams in `@nifrajs/core/mount`: `NIFRA_BACKEND_BIND_PLATFORM` (returns a platform-bound view of an
in-process client) and `NIFRA_PLATFORM_CLIENT_IP_DERIVED` (marks a platform whose `clientIp` an enclosing
server already derived, so a backend with its own `clientIp` trust keeps it instead of re-reading
forwarding headers a synthesized request does not carry).
