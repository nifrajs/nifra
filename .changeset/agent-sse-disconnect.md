---
"@nifrajs/agent": patch
"@nifrajs/ag-ui": patch
---

An SSE client that disconnects mid-run no longer ends the turn as failed. With an `evidenceLog`, the run keeps going and records its real result, so a `Last-Event-ID` reconnect replays that result instead of `run_failed`/`RUN_ERROR`. Without an `evidenceLog`, the disconnect aborts `ports.signal` (combined with any signal the caller's ports carry), so the model and tool loop stop and the turn suspends as `cancelled`.
