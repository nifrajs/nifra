# @nifrajs/agent-protocol

## 5.10.0

No changes in this release.

## 5.9.0

### Patch Changes

- 5bc60b7: Small helpers that several modules of a package each defined (the object check, RegExp escaping, `\` to `/` path conversion, line lookup) now have one definition per package. No API or behavior change.

## 5.8.0

No changes in this release.

## 5.7.0

No changes in this release.

## 5.6.0

### Minor Changes

- 2248445: `@nifrajs/agent-protocol` exports `childProcessEnv` and `childProcessBaseEnv`: the environment a host
  hands a process it spawns, built from the platform and host environment the caller passes. The ACP
  and Pi backends and the coding agent's isolated extension worker build their child environments with
  it, so all three pass the same Windows set. An ACP agent on Windows now also receives `BUN_INSTALL`
  and `USERDOMAIN`.

## 5.5.1

No changes in this release.

## 5.5.0

No changes in this release.

## 5.4.0

No changes in this release.

## 5.3.0

No changes in this release.

## 5.2.1

No changes in this release.

## 5.2.0

### Patch Changes

- 9498cf8: The package ships its `CHANGELOG.md`, so the installed package has the notes for every version, as the GitHub release does. Before, the tarball held only the code, `README.md`, `LICENSE` and `package.json`.

## 5.1.0

### Patch Changes

- abb4354: The package now ships the MIT `LICENSE` text, as every other @nifrajs package already did.

## 5.0.0

### Minor Changes

- 36bdc71: `@nifrajs/agent-protocol/conformance` exports `checkAgentBackend`, which drives an `AgentBackend` through the scenarios a host relies on (session snapshot, a valid turn that completes, a refused second message, cancel, approvals allowed, denied, unknown and cancelled, a closed session) and returns a report of passed, failed, and skipped checks. `AgentBackend.resolveApproval` now documents its result: a boolean once the backend took the answer, `undefined` when it does not know the approval. `PiBackend` forgets a turn's pending approvals when the turn ends, so an answer after a cancel returns `undefined` instead of reaching Pi.
- 6b0db44: feat(agent-protocol): `splitAgentText`, `boundAgentText`, and `boundAgentValue` keep a backend's events inside the protocol's bounds, with `AGENT_MAX_EVENT_TEXT` (256 KiB) and `AGENT_MAX_PAYLOAD_STRING` (64 KiB) naming them. `splitAgentText` turns a long reply into consecutive pieces that each fit an event and join back to the text; `boundAgentText` cuts one field with a marker; `boundAgentValue` makes a display copy of a tool's input or output (strings cut with a marker, arrays, keys, depth, and nodes kept within the limits, a `__proto__` key kept as an own entry). All three replace NUL, which `isAgentEvent` refuses, with U+FFFD and never cut between the halves of a surrogate pair.
- a3b3c51: Backends can send their own events. A `type` of `x-<vendor>.<name>` (lowercase, at most 64 characters) with an optional `turnId` and a bounded `data` value is now a valid `AgentEvent` (`AgentExtensionEvent`, `isAgentExtensionEventType`). Before, `isAgentEvent` refused every type the protocol did not define, so a vendor frame such as Codex's plan or a reviewer notice failed the whole turn. `CodingAgentHost` passes extension events through, records only their type and turn as evidence, and takes `extensionEvents: { "x-codex.plan": (event) => boolean }` to check the types it knows; a refused one fails the turn like a malformed event. `@nifrajs/agent-app`'s `toEventView` projects one to `ExtensionEventView` (type, turn, `hasData`, never the data). An exhaustive `switch` over `event.type` now needs a `default` branch for extension events.

  `agentEventProblem(value)` says why an event is invalid, naming the field and the limit it broke but never its content, and the host's `BACKEND_PROTOCOL` failure now carries it: `backend emitted an invalid agent event: turn.started.prompt is longer than 262144 characters` instead of the bare first half.

- b435f13: Three events join the protocol: `reasoning.delta` (`turnId`, optional `itemId`, `text`), `plan.updated` (`turnId`, optional `callId` and `explanation`, and `entries` of `content` up to 4096 characters, `status` `pending` | `in_progress` | `completed`, optional `priority`; each event is the whole plan), and `context.usage` (`usedTokens`, optional `windowTokens`, `inputTokens`, `outputTokens`, `cachedInputTokens`, `reasoningTokens`, `estimated`). The plan entry shape is ACP's. `NifraBackend`'s model port can stream `{ type: "reasoning_delta", text, itemId? }` and `{ type: "usage", usedTokens, ... }` chunks, which become those events; a count that is not a non-negative integer is dropped. `CodingAgentHost` keeps only counts as evidence (a plan's entry and completed counts, never its text), and `toEventView` projects them to `ReasoningDeltaView`, `PlanUpdatedView`, and `ContextUsageView` (with `fill` when the window is known). An exhaustive `switch` over `event.type` needs the three new cases.

### Patch Changes

- 343bae0: `createAgentEventStream` now drops the oldest `assistant.delta` or `tool.delta` when a slow consumer fills the queue, and drops a lifecycle event such as `tool.started` only once no delta is left. A host that records session evidence from a backend's live stream keeps its tool and turn events.

## 4.0.2

## 4.0.1

## 4.0.0

## 3.5.0

## 3.4.0

### Patch Changes

- 8d23613: Add the opt-in `@nifrajs/webmcp` package: typed WebMCP registration, core-backed receipts, deterministic predictive-UI reconciliation, and host-independent conformance checks. Also tighten agent execution cancellation cleanup so aborted local work cannot leak into later turns.

## 3.3.0

## 3.2.0

### Minor Changes

- e3e197b: Add the isolated Nifra agent protocol, Pi backend adapter, extensible coding-agent CLI, secure local RPC, workflows, sessions, verification, self-healing extensions, and Workbench integration.
