---
"@nifrajs/core": patch
"@nifrajs/better-auth": patch
---

An `authenticate()` stage that throws, or returns anything but `authenticated(principal)` or `rejected(...)`, still answers 503 `{ ok: false, error: "auth_unavailable" }`, and its cause now goes where a handler's error goes: to `onError`, whose response replaces the 503, and when no hook answers, to the logger as `unhandled request error`. Before, the cause was dropped, so a database outage during authentication left only a 503 in the access log. A malformed decision is reported as a `TypeError` naming the stage. A stage that throws a `Response` or `status(...)`, such as `requirePrincipal`'s 401 or redirect, now has it sent as thrown, as from a handler, instead of a 503. `authed()` from `@nifrajs/better-auth` no longer catches provider failures itself, so they are reported the same way.
