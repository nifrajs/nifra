---
"@nifrajs/ag-ui": minor
---

Live token streaming and the AG-UI state channel. A streaming model port now turns into live `TEXT_MESSAGE_*` frames (the terminal text block is suppressed when text was streamed), `REASONING_*` messages, and provisional `TOOL_CALL_START` + `TOOL_CALL_ARGS` calls that the following tool evidence closes. The `ports` factory receives `(c, run)` with `run.turnId` and `run.sharedState`: `body.state` seeds the document (announced as `STATE_SNAPSHOT`), and every patch streams as `STATE_DELTA` with RFC 6902 ops. `usage` deltas are summed per `(provider, model)` and stamped as the spec `usage: TokenUsage[]` array on the terminal `RUN_FINISHED` - kept by the stored terminal events, so a replayed stream reports the same totals. Non-streaming ports and existing single-argument `ports` factories are unaffected.
