---
"@nifrajs/pi": patch
---

fix(pi): a Pi turn whose model call failed ends in `session.failed` with code `PI_MODEL_FAILED` and Pi's error message, instead of `session.completed` with no answer. Pi reports such a failure only on the turn's last assistant message (`stopReason: "error"`) and still ends with an ordinary `agent_end`, so a sign-in, quota, or network failure used to look like an empty success. An `agent_end` Pi marks `willRetry` no longer ends the turn: the retried run's answer completes it.
