---
"@nifrajs/core": minor
---

Order-scoped hooks (`derive`, `decorate`, `beforeHandle`, `afterHandle`, `around`, `aroundCapability`,
`onError`) are snapshotted into each route as it is declared, so one added after the last route was
registered silently applies to nothing. This is the trap a route-registering factory sets: the app it
returns has already declared its routes, so `app.use(requestId())` on it reaches zero of them.

The server now detects this at seal - the first `listen()`, `fetch`, or `resolveNode` - and reports
every order-scoped hook that covers no route, naming the hook kind and the call site so the fix (move
it before the routes it should cover) is obvious. A previously-silent mistake now logs once at startup.

New `unusedScopedHooks` server option: `"warn"` (default) logs the report, `"error"` throws a
`FrameworkError` (`UNUSED_SCOPED_HOOKS`), `"off"` skips the check and its bookkeeping entirely. The
report routes through a configured `logger`, else `console.warn`. Legitimate group scoping - a hook
that intentionally covers only the routes declared after it - is never flagged, and app-global hooks
(`onRequest`/`onResponse`/...) are unaffected because they are not order-scoped.

The audit is a development-time diagnostic: it is guarded by `process.env.NODE_ENV !== "production"`, so
any bundler that defines `NODE_ENV` strips it entirely from production builds - it adds zero bytes to
the shipped bundle and zero per-request cost. It fires in development, test, and CI, where the mistake
is caught, not in production.
