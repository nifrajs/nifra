---
"@nifrajs/agent-protocol": minor
"@nifrajs/coding-agent": minor
"@nifrajs/agent-app": minor
---

Backends can send their own events. A `type` of `x-<vendor>.<name>` (lowercase, at most 64 characters) with an optional `turnId` and a bounded `data` value is now a valid `AgentEvent` (`AgentExtensionEvent`, `isAgentExtensionEventType`). Before, `isAgentEvent` refused every type the protocol did not define, so a vendor frame such as Codex's plan or a reviewer notice failed the whole turn. `CodingAgentHost` passes extension events through, records only their type and turn as evidence, and takes `extensionEvents: { "x-codex.plan": (event) => boolean }` to check the types it knows; a refused one fails the turn like a malformed event. `@nifrajs/agent-app`'s `toEventView` projects one to `ExtensionEventView` (type, turn, `hasData`, never the data). An exhaustive `switch` over `event.type` now needs a `default` branch for extension events.

`agentEventProblem(value)` says why an event is invalid, naming the field and the limit it broke but never its content, and the host's `BACKEND_PROTOCOL` failure now carries it: `backend emitted an invalid agent event: turn.started.prompt is longer than 262144 characters` instead of the bare first half.
