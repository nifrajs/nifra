# @nifrajs/agent-app

A presentation-safe browser SDK for Nifra agent hosts.

This package depends on **only** `@nifrajs/agent-protocol`. It pulls in no backend, model provider,
storage, or UI framework, so it can be bundled into browser-facing code without dragging a private
engine or payload content across the boundary. Everything it surfaces upward is a content-free view
model: identifiers, lifecycle statuses, counters, and opaque references. A prompt becomes a character
count; a tool result becomes an `ok` flag and an error *code*; a compaction becomes before/after token
counts.

## What it does

- **Feature negotiation.** On session creation the client intersects the features it can drive with the
  capabilities the host advertises, and gates the matching operations behind `requireFeature`.
- **Caller auth.** An optional `authorize` hook mints a bearer token per request. The token is placed
  on the outgoing `Authorization` header and never stored on the transport, copied into a result, or
  written to a log.
- **Ordered, deduplicated streaming.** A turn arrives as an ordered stream of `AgentEventView`s.
  Out-of-order and redelivered frames are reordered and de-duplicated by sequence; a bounded buffer
  skips an unfilled gap rather than stalling.
- **Cursor resume.** A persisted log can be replayed from a cursor. A cursor whose next record was
  evicted from the retained window asks the caller to resync.
- **Approvals and handoffs.** Pending approvals list as identifiers; decisions and handoff outcomes go
  back through negotiated commands.
- **Escape hatch.** `command()` reaches host-specific surfaces outside the negotiated contract and
  still returns a bounded `CommandOutcome` - it never throws the credential.

## Usage

```ts
import { AgentAppClient, HttpAgentTransport } from "@nifrajs/agent-app"

const transport = new HttpAgentTransport({
  endpoint: "http://127.0.0.1:8787",
  authorize: () => currentToken(), // per-request; never stored
})
const client = new AgentAppClient(transport)

const session = await client.createSession()
if (client.supports("resume")) {
  const replay = await client.resume({ cursor: lastCursor })
  // replay.entries: { seq, at, type }[] - no payloads
}

for await (const view of client.send("summarize the diff")) {
  // view is content-free: e.g. { kind: "assistant.delta", seq, chars }
}
```

## Boundary

The transport receives the host's full event stream in order to derive counts, but the client's public
output is projected to content-free view models. That projection is the seam: an application built on
this SDK can render progress and resolve interactions, and cannot reconstruct a prompt, tool payload,
model completion, diagnostic report, or filesystem path. The `scripts/check-agent-boundary.ts` gate
enforces that this package imports nothing but `@nifrajs/agent-protocol`.

## License

MIT
