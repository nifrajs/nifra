# @nifrajs/agent-app

## 5.2.1

### Patch Changes

- @nifrajs/agent-protocol@5.2.1

## 5.2.0

### Patch Changes

- 9498cf8: The package ships its `CHANGELOG.md`, so the installed package has the notes for every version, as the GitHub release does. Before, the tarball held only the code, `README.md`, `LICENSE` and `package.json`.
- Updated dependencies [9498cf8]
  - @nifrajs/agent-protocol@5.2.0

## 5.1.0

### Patch Changes

- abb4354: The package now ships the MIT `LICENSE` text, as every other @nifrajs package already did.
- Updated dependencies [abb4354]
  - @nifrajs/agent-protocol@5.1.0

## 5.0.0

### Minor Changes

- 7391acd: `AgentAppClient.send` resumes a turn whose stream breaks mid-turn: it calls `turn.attach` with the last seq it received and goes on yielding views without a gap or a repeat. `resumeAttempts` (default 3, counted since the last attach that delivered a new event; 0 turns it off) and `resumeDelayMs` (default 250) bound it. A host that refuses the attach (it keeps no turns, or no longer holds those events) leaves `send` throwing the original break, as before. `AgentTransportError` now carries the response `status` when a host refused a stream.
- 4417bc9: `AgentAppClient.send()` streams a turn on a session other clients share. A turn's events used to wait behind the seqs that went to another tab's turns, a gap that never fills, so that tab saw no events at all. A turn now starts at its first event, and anything still held behind a gap is released, in order, when the stream ends. `OrderedEventBuffer` gains `flush()` for the same purpose: it releases every held event and counts the missing seqs on `dropped`.
- a3b3c51: Backends can send their own events. A `type` of `x-<vendor>.<name>` (lowercase, at most 64 characters) with an optional `turnId` and a bounded `data` value is now a valid `AgentEvent` (`AgentExtensionEvent`, `isAgentExtensionEventType`). Before, `isAgentEvent` refused every type the protocol did not define, so a vendor frame such as Codex's plan or a reviewer notice failed the whole turn. `CodingAgentHost` passes extension events through, records only their type and turn as evidence, and takes `extensionEvents: { "x-codex.plan": (event) => boolean }` to check the types it knows; a refused one fails the turn like a malformed event. `@nifrajs/agent-app`'s `toEventView` projects one to `ExtensionEventView` (type, turn, `hasData`, never the data). An exhaustive `switch` over `event.type` now needs a `default` branch for extension events.

  `agentEventProblem(value)` says why an event is invalid, naming the field and the limit it broke but never its content, and the host's `BACKEND_PROTOCOL` failure now carries it: `backend emitted an invalid agent event: turn.started.prompt is longer than 262144 characters` instead of the bare first half.

- b435f13: Three events join the protocol: `reasoning.delta` (`turnId`, optional `itemId`, `text`), `plan.updated` (`turnId`, optional `callId` and `explanation`, and `entries` of `content` up to 4096 characters, `status` `pending` | `in_progress` | `completed`, optional `priority`; each event is the whole plan), and `context.usage` (`usedTokens`, optional `windowTokens`, `inputTokens`, `outputTokens`, `cachedInputTokens`, `reasoningTokens`, `estimated`). The plan entry shape is ACP's. `NifraBackend`'s model port can stream `{ type: "reasoning_delta", text, itemId? }` and `{ type: "usage", usedTokens, ... }` chunks, which become those events; a count that is not a non-negative integer is dropped. `CodingAgentHost` keeps only counts as evidence (a plan's entry and completed counts, never its text), and `toEventView` projects them to `ReasoningDeltaView`, `PlanUpdatedView`, and `ContextUsageView` (with `fill` when the window is known). An exhaustive `switch` over `event.type` needs the three new cases.

### Patch Changes

- c8577dd: The coding-agent RPC `approval.list` names each pending approval `approvalId`, the name `approval.resolve` takes, and keeps `id`. `AgentAppClient.listApprovals()` reads either name, so pending approvals from the RPC host are no longer dropped. The workbench refreshes its approval list when a turn reports `approval.required` or `approval.resolved`, while the turn is still streaming.
- 7775c2b: Detach AG-UI viewers on initial or later output overflow, cancel unlogged work, and preserve logged run results for replay. Parse fragmented agent SSE frames with linear scanning and UTF-8 accounting. Bound each DevTools connection's pending bytes and close stalled readers, replaying only the recent history that fits.
- Updated dependencies [36bdc71]
- Updated dependencies [6b0db44]
- Updated dependencies [a3b3c51]
- Updated dependencies [343bae0]
- Updated dependencies [b435f13]
  - @nifrajs/agent-protocol@5.0.0

## 4.0.2

### Patch Changes

- @nifrajs/agent-protocol@4.0.2

## 4.0.1

### Patch Changes

- @nifrajs/agent-protocol@4.0.1

## 4.0.0

### Patch Changes

- 930ed0d: `AgentAppClient.send()` delivers every turn, not only the first. The client advances `session.lastSeq` as it yields each event, and the next turn's ordering buffer starts after it. Previously a second turn's events waited behind a gap that never filled, and the turn yielded nothing.
- db9d1e1: The view models hold their input to one shape:

  - `boundaryIsStale` treats an expiry or a clock that is not a number as stale, so `boundaryCommands` offers no command for that boundary.
  - `toRunStudioView` refuses a run graph that lists the same node twice, instead of rendering it twice and counting it twice.
  - `toReviewView` reads the `report` inside a host result as a review report only. A host result nested inside another projects as the `invalid-report` unavailable view. Duplicate finding ids are checked in linear time, so a report at the 4,096-finding cap parses in about 5 ms instead of 22 ms.

- ef28ef9: Run views list nodes, checks and findings in code-unit order of their ids, the same in every locale.
  - @nifrajs/agent-protocol@4.0.0

## 3.5.0

### Patch Changes

- 6430334: Add the provider-neutral, content-free review report contract and expose `nifra review` through the CLI, authenticated agent RPC, and Workbench-safe view projections.
  - @nifrajs/agent-protocol@3.5.0

## 3.4.0

### Patch Changes

- 8d23613: Add the opt-in `@nifrajs/webmcp` package: typed WebMCP registration, core-backed receipts, deterministic predictive-UI reconciliation, and host-independent conformance checks. Also tighten agent execution cancellation cleanup so aborted local work cannot leak into later turns.
- Updated dependencies [8d23613]
  - @nifrajs/agent-protocol@3.4.0

## 3.3.0

### Patch Changes

- @nifrajs/agent-protocol@3.3.0

## 3.2.0

### Patch Changes

- 1a041a9: Add provider-neutral gateway and deployment contracts with deterministic reference adapters and evidence-safe policy checks.
- Updated dependencies [e3e197b]
  - @nifrajs/agent-protocol@3.2.0
