import { performance } from "node:perf_hooks"
import { type AgentEvent, createAgentEventStream } from "@nifrajs/agent-protocol"
import { ContextWindow } from "@nifrajs/coding-agent"

const count = Number(Bun.argv.find((arg) => arg.startsWith("--events="))?.slice(9) ?? "10000")
if (!Number.isSafeInteger(count) || count < 100 || count > 1_000_000)
  throw new Error("--events must be between 100 and 1000000")

const sample: AgentEvent = {
  version: 1,
  sessionId: "bench",
  seq: 0,
  at: 0,
  type: "assistant.delta",
  turnId: "turn",
  text: "x",
}

const streamStart = performance.now()
const stream = createAgentEventStream(512)
for (let index = 0; index < count; index++) stream.push({ ...sample, seq: index })
stream.complete()
let consumed = 0
for await (const _event of stream) consumed++
const streamMs = performance.now() - streamStart

const contextStart = performance.now()
const context = new ContextWindow({ maxTokens: 2_048, keepRecent: 16 })
let compactions = 0
for (let index = 0; index < count; index++) {
  if (
    context.append({ kind: "assistant.delta", content: `record ${index} ${"x".repeat(64)}` }) !==
    undefined
  )
    compactions++
}
const contextMs = performance.now() - contextStart

const result = {
  events: count,
  consumed,
  dropped: stream.dropped,
  eventStreamMs: round(streamMs),
  eventStreamEventsPerSecond: round((count / Math.max(streamMs, 0.01)) * 1_000),
  contextRecords: context.size,
  contextTokens: context.tokens,
  compactions,
  contextMs: round(contextMs),
}
if (Bun.argv.includes("--json")) console.log(JSON.stringify(result))
else {
  console.log(
    `agent event stream: ${result.eventStreamEventsPerSecond.toLocaleString()} events/s (${result.eventStreamMs}ms, ${result.dropped} transient drops)`,
  )
  console.log(
    `context window: ${result.contextMs}ms (${result.compactions} compactions, ${result.contextTokens} estimated tokens retained)`,
  )
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
