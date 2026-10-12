# @nifrajs/a2a

## 5.1.0

### Patch Changes

- abb4354: The package now ships the MIT `LICENSE` text, as every other @nifrajs package already did.
- b5ff0bb: `mountA2A` defaults `resumeApproval` to `"port"`: a resumed task asks `ports.approval` again and hands it the peer's `approval` as `callerDecision`, so the agent that asked for a tool can no longer approve its own call. Without an approval port such a resume stays `TASK_STATE_INPUT_REQUIRED`. Return `resumeApproval: "caller"` from `ports` to keep the previous behavior when the peer is the approver, such as a human operator's client.

## 5.0.0

### Patch Changes

- 44cc946: A client that disconnects from a `SendStreamingMessage` stream now aborts the agent run's signal, so model and tool calls that honour it stop instead of running to the end for nobody. A signal passed through `ports` is still honoured alongside it.
- 34b3014: New `resumeApproval: "port"` agent port option keeps the configured approval port authoritative when a run resumes. By default a step that suspended for approval takes the decision the resuming caller sends in `resume.approval`. Over A2A, or on a public AG-UI or `mountAgent` route, that caller can be the party asking for the tool. With `resumeApproval: "port"` the approval port is asked again and receives the caller's decision as `callerDecision`, and its verdict stands. Without a port, such a resume suspends again.
- 848ce97: `resumeAgent` accepts the continuation of a model, budget or cancelled suspension: echoing it back retries the model step, as omitting `resume` does, so an A2A client can resume such a task with the continuation the task reported. A continuation that names a tool or a different effect is still refused with `AgentResumeMismatchError`.
- Updated dependencies [2198640]
- Updated dependencies [6b96131]
- Updated dependencies [d6a7fa0]
- Updated dependencies [6340cd8]
- Updated dependencies [34b3014]
- Updated dependencies [848ce97]
- Updated dependencies [a0a02f4]
- Updated dependencies [0aed425]
- Updated dependencies [eaf030b]
- Updated dependencies [7de0397]
- Updated dependencies [1af7543]
- Updated dependencies [4199ff3]
- Updated dependencies [90d9ee6]
- Updated dependencies [364a234]
- Updated dependencies [c06cba5]
- Updated dependencies [f4d3852]
- Updated dependencies [4a82ae0]
- Updated dependencies [0ff867a]
- Updated dependencies [e7391bf]
- Updated dependencies [0b80a59]
- Updated dependencies [c64db12]
- Updated dependencies [3753104]
- Updated dependencies [4b3b1fa]
- Updated dependencies [3562557]
- Updated dependencies [53087f3]
- Updated dependencies [2def6c7]
- Updated dependencies [b5b5bc3]
- Updated dependencies [22e1777]
- Updated dependencies [3a483cd]
- Updated dependencies [35f52c7]
- Updated dependencies [343cb81]
- Updated dependencies [d91fd44]
- Updated dependencies [b13e071]
- Updated dependencies [077657f]
- Updated dependencies [a5963cb]
- Updated dependencies [05aac0e]
- Updated dependencies [1a6616f]
- Updated dependencies [7775c2b]
- Updated dependencies [846e2f6]
- Updated dependencies [aadd9fc]
- Updated dependencies [ea16748]
- Updated dependencies [fc0284a]
- Updated dependencies [5b22f4d]
- Updated dependencies [1b94593]
- Updated dependencies [9f58295]
- Updated dependencies [b9608ac]
- Updated dependencies [7a165de]
- Updated dependencies [4064f36]
- Updated dependencies [48aad8c]
- Updated dependencies [41050ed]
- Updated dependencies [fc837cb]
- Updated dependencies [b80ce77]
- Updated dependencies [9b1acc9]
- Updated dependencies [740109f]
- Updated dependencies [e0a25fe]
- Updated dependencies [3630b6e]
- Updated dependencies [1290c6d]
- Updated dependencies [d0a7d58]
  - @nifrajs/agent@5.0.0
  - @nifrajs/core@5.0.0

## 4.0.2

## 4.0.1

## 4.0.0

### Minor Changes

- 0e96829: Every reply on the A2A JSON-RPC route is now a JSON-RPC response. A result larger than `maxOutputBytes`, or one that cannot be serialized, answers with HTTP 200 and a `-32603` error (`output_limit` or `response_serialization_failed`) for the request's `id`, where it was an HTTP 500 with a bare `{ "error": ... }` body. A request whose `ports` or state store throws keeps its `id` in the `-32603 internal_error` reply instead of `null`.

### Patch Changes

- eb01d37: A `maxOutputBytes` above the 4 MiB default now applies to `SendMessage` and `GetTask` responses. A larger result was answered with `500 { "error": "response_too_large" }` even when the configured limit allowed it.
- d2329f5: A resume continues only the step the turn suspended on. The saved state keeps a SHA-256 digest of the suspended tool input, and a continuation that names another tool, effect id or kind, or replays different input, is refused with `AgentResumeMismatchError` before anything runs (`mountAgent` answers 409). A caller's `approval` answers only a step that suspended for approval; a step suspended for budget or cancellation asks the approval port again.
- Updated dependencies [6695a23]
- Updated dependencies [7b2ff47]
- Updated dependencies [422248c]
- Updated dependencies [62115dd]
- Updated dependencies [dbc91b6]
- Updated dependencies [d2329f5]
- Updated dependencies [1eb77df]
- Updated dependencies [dde125b]
- Updated dependencies [72b62fa]
- Updated dependencies [aa44e93]
- Updated dependencies [4a3ee60]
- Updated dependencies [aad6297]
- Updated dependencies [dad0d41]
- Updated dependencies [538adc2]
- Updated dependencies [f47edd1]
- Updated dependencies [df9530a]
- Updated dependencies [3e6973f]
- Updated dependencies [25e8edf]
- Updated dependencies [2b5e5fc]
- Updated dependencies [3b090de]
- Updated dependencies [da7d792]
- Updated dependencies [612a296]
- Updated dependencies [fb14dfa]
- Updated dependencies [8ae97f6]
- Updated dependencies [4af6f39]
- Updated dependencies [ca8b50d]
- Updated dependencies [b00a889]
- Updated dependencies [b53d64f]
- Updated dependencies [66fd712]
- Updated dependencies [9c3d524]
- Updated dependencies [738e7a1]
- Updated dependencies [4801cac]
- Updated dependencies [1b2d53a]
- Updated dependencies [25fe13d]
- Updated dependencies [0852290]
- Updated dependencies [0589dbe]
- Updated dependencies [2e2d8c0]
- Updated dependencies [856f5ce]
- Updated dependencies [18aa5aa]
- Updated dependencies [cfd86b3]
- Updated dependencies [8ff96c9]
- Updated dependencies [4c46199]
- Updated dependencies [eef4932]
- Updated dependencies [6de8686]
- Updated dependencies [d7892ea]
- Updated dependencies [4936309]
- Updated dependencies [ff5a779]
- Updated dependencies [bbdc5a1]
- Updated dependencies [10bc446]
- Updated dependencies [e8270d9]
- Updated dependencies [ff4a062]
- Updated dependencies [43ba944]
- Updated dependencies [46c741a]
- Updated dependencies [7bfa25e]
- Updated dependencies [4936309]
- Updated dependencies [6e257a6]
- Updated dependencies [4a03d30]
- Updated dependencies [8e30090]
- Updated dependencies [28f3aaf]
- Updated dependencies [6d20355]
- Updated dependencies [6907cbe]
- Updated dependencies [b64c3ee]
- Updated dependencies [bda9637]
- Updated dependencies [81c720e]
- Updated dependencies [ed60b23]
- Updated dependencies [a158b74]
- Updated dependencies [ff25d68]
  - @nifrajs/agent@4.0.0
  - @nifrajs/core@4.0.0

## 3.5.0

### Patch Changes

- d5b7c22: Harden request boundaries, error handling, resource limits, signing, and cross-runtime adapters for safer production releases.

## 3.4.0

## 3.3.0

## 3.2.0

### Minor Changes

- fdca0ce: New agent protocol adapter packages. `@nifrajs/a2a` mounts a nifra agent as an Agent2Agent (A2A) 1.0 server: the agent card on GET, the JSON-RPC binding on POST with `SendMessage`, `SendStreamingMessage` (step evidence over SSE), and `GetTask`, plus human-in-the-loop resume through message metadata. `@nifrajs/ag-ui` mounts the same agent as an AG-UI endpoint: `RunAgentInput` in, the AG-UI event stream out - run lifecycle, tool-call and step events, text message events for the output, and a typed continuation for resume. Both are protocol bridges over `@nifrajs/agent` - the request body goes through core's bounded, prototype-guarded framing lane, and the model, state store, and approval transport are injected per request.

### Patch Changes

- 893f7b3: Agent-run tracing and composable telemetry ports.

  `@nifrajs/agent-telemetry` gains `traceAgentRun`: one OpenTelemetry span per bounded agent run, one
  child span per step evidence item, with tool names, effect ids, error codes, and effect-ledger heads
  as span attributes. Only the runner's constrained token-only evidence is exported; telemetry is
  fail-open and can never fail the turn it observes.

  `@nifrajs/agent` gains `combineAgentTelemetry` to fan one run's step evidence out to several
  telemetry ports. The HTTP seams - `mountAgent`, the A2A adapter, and the AG-UI adapter - now compose
  their SSE evidence stream with a caller-injected telemetry port instead of replacing it.
