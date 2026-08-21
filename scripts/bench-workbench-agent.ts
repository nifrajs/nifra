/** Replay-backed Workbench evidence benchmark. It measures projection and bounded-window work only. */

import { performance } from "node:perf_hooks"
import { toEvidenceTimelineView, toRunStudioView, virtualizeEvidenceRows } from "@nifrajs/agent-app"

const CHECK = Bun.argv.includes("--check")
const rows = Array.from({ length: 2_000 }, (_unused, seq) => ({
  seq,
  eventId: `run:${seq}`,
  runId: "bench-run",
  nodeId: `node-${seq % 256}`,
  status: seq % 7 === 0 ? "retrying" : "completed",
  attempt: seq % 7 === 0 ? 2 : 1,
  scheduleToken: `schedule:${seq}`,
}))
const start = performance.now()
const timeline = toEvidenceTimelineView(rows)
const window = virtualizeEvidenceRows(timeline, timeline.length - 1, 100)
const run = toRunStudioView({
  runId: "bench-run",
  planId: "bench-plan",
  planDigest: "a".repeat(64),
  cursor: timeline.length - 1,
  state: "succeeded",
  nodes: Array.from({ length: 256 }, (_unused, index) => ({
    nodeId: `node-${index}`,
    dependsOn: index === 0 ? [] : [`node-${index - 1}`],
    state: "succeeded",
    attempt: 1,
    retryCount: 0,
    checkpointed: true,
    cancelled: false,
    recovered: false,
  })),
})
const elapsed = performance.now() - start
const maxMs = 16
if (CHECK) {
  if (timeline.length !== 2_000)
    throw new Error("workbench benchmark: timeline projection lost rows")
  if (window.rows.length !== 100)
    throw new Error("workbench benchmark: evidence window is not virtualized")
  if (run?.nodes.length !== 256)
    throw new Error("workbench benchmark: run graph projection lost nodes")
  if (elapsed > maxMs) throw new Error(`workbench benchmark: projection exceeded ${maxMs}ms`)
}
console.log(
  JSON.stringify({
    check: CHECK,
    rows: timeline.length,
    visible: window.rows.length,
    nodes: run?.nodes.length ?? 0,
    ms: Math.round(elapsed * 1000) / 1000,
  }),
)
