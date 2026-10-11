# @nifrajs/agent-protocol

Small, backend-neutral contracts for local coding-agent sessions.

The package contains versioned session snapshots, streamed assistant/tool/approval
events, bounded live event streams, and backend interfaces. It has no runtime
dependencies and does not import Nifra framework packages, model SDKs, or UI code.

```ts
import { createAgentEventStream } from "@nifrajs/agent-protocol"

const events = createAgentEventStream(256)
events.push(/* a versioned AgentEvent */)
```

`isAgentEvent` refuses an event past the protocol's bounds: 256 KiB characters of `text`, `prompt`, or
error message, and 64 KiB per string inside `input`, `output`, or `details`. A backend keeps its
events inside them with `splitAgentText` (a long reply as consecutive events that join back),
`boundAgentText` (one field, cut with a marker), and `boundAgentValue` (a display copy of a tool's
input or output; the tool itself still gets the whole value). `agentEventProblem` says why an event
was refused, naming the field and the limit but never its content.

Three events carry what most coding agents report besides their reply: `reasoning.delta` (a piece
of the model's reasoning, grouped by an optional `itemId`), `plan.updated` (the whole current plan,
entries of `content`, `status`, and optional `priority`, each event replacing the last), and
`context.usage` (`usedTokens` of the latest request, the model's `windowTokens` when known, and
optional input, output, cached, and reasoning counts).

Any other frame a backend has of its own travels as an extension event:
`type` is `x-<vendor>.<name>` (lowercase, at most 64 characters), with an optional `turnId` and a
`data` value inside the same payload bounds. Hosts that do not know the type pass it through; a host
that does can register a check for it.

```ts
yield { version: 1, sessionId, seq, at: Date.now(), type: "x-codex.plan", turnId, data: { steps } }
```

Use `@nifrajs/pi` for the Pi backend or implement `AgentBackend` for another
runtime. The protocol is intentionally small so CLI, desktop, mobile, and CI
clients can share it without pulling in the Nifra application framework.

## Conformance kit

`@nifrajs/agent-protocol/conformance` drives an `AgentBackend` through what a host relies on and
returns a report, so an adapter for another agent can prove itself in any test runner:

```ts
import { checkAgentBackend } from "@nifrajs/agent-protocol/conformance"

const report = await checkAgentBackend({
  backend: () => new MyBackend(),
  cwd: process.cwd(),
  prompt: "say hi",
  slowPrompt: "wait until cancelled", // enables turn.busy and turn.cancel
  approvalPrompt: "write a file", // enables the approval checks
})
expect(report.checks.filter((check) => check.status === "failed")).toEqual([])
```

Each scenario gets a fresh backend and session. The checks: a valid session snapshot; a turn whose
events are valid, ordered, of one turn, and end with exactly one terminal event; `session.completed`
for a plain turn and an idle snapshot after it; a second message refused while a turn runs, without
ending it; a cancel that ends with `session.stopped` and leaves the session usable; approvals allowed
and denied; `undefined` from `resolveApproval` for an approval it never asked for or whose turn was
cancelled; and no turn for a closed session.

## Version 1 compatibility

Version 1 is additive. Hosts advertise capabilities and clients use only the negotiated intersection;
an unsupported command is a stable `feature_unsupported` result. Optional fields are ignored by older
peers, while a cursor gap returns `resync_required` instead of silently skipping evidence. A future
major requires a recorded semantic incompatibility, dual decoders, cross-version fixtures, and an
approved migration plan.

Run evidence and lifecycle values are structural only: identifiers, statuses, counters, timestamps,
digests, and opaque references. Prompts, model output, tool arguments, and filesystem paths do not
belong in these public contracts.

For AI agents, see [`LLM.md`](./LLM.md) and the full corpus
[`../../llms-full.txt`](../../llms-full.txt).
