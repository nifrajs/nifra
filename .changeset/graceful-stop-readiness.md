---
"@nifrajs/core": minor
"@nifrajs/node": minor
"@nifrajs/deno": minor
"@nifrajs/middleware": minor
"@nifrajs/cli": patch
---

A stop now tells the load balancer before it drains. `app.onStopping(fn)` runs as `stop()` begins,
before in-flight requests drain, and `stop({ delayMs })` (or `gracefulSignals: { delayMs }`, and
`signals: { delayMs }` on the Node and Deno adapters) keeps serving that long first, so a balancer
polling readiness takes the instance out of rotation while it still answers. `onStop` hooks run after
the drain as before, on Node and Deno too.

`healthcheck()` readiness is reworked for production probes:

- `/ready` answers `503 { status: "stopping" }` from the moment a stop begins, without running a
  check.
- Each check gets an `AbortSignal` and a timeout (`timeoutMs`, default 2 s, settable per check), and
  reports `timeout` past it.
- A check is never called again while an earlier call still runs, probes arriving during a run share
  it, and a finished run answers probes for `cacheMs` (default 1 s).
- A check marked `optional: true` reports `degraded` and keeps `/ready` at `200`.
- A check moving between passing and failing is logged once each way (`logger`, default
  `jsonLogger()`).

The `/ready` body changes shape: each check is now `{ status: "pass" | "fail" | "timeout", ms }`
(plus `optional: true`) where it was a boolean, and the top-level `status` can also be `degraded` or
`stopping`. A monitor that reads the body rather than the status code needs updating.

`nifra doctor` counts an `onStopping` hook as graceful-shutdown handling.
