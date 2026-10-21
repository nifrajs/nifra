import assert from "node:assert/strict"
import { test } from "node:test"
import { parseOha, summarize } from "./measurements.mjs"

const valid = () => ({
  summary: { successRate: 1, requestsPerSec: 1000 },
  latencyPercentiles: { p50: 0.001, p99: 0.002 },
  statusCodeDistribution: { 200: 100 },
  errorDistribution: {},
})
test("reject failed requests, misleading HTTP errors, and malformed load samples", () => {
  assert.deepEqual(parseOha(JSON.stringify(valid()), 100), {
    rps: 1000,
    p50ms: 1,
    p99ms: 2,
    completed: 100,
  })
  for (const mutate of [
    (d) => {
      d.summary.successRate = 0.99
    },
    (d) => {
      d.statusCodeDistribution = { 200: 99, 500: 1 }
    },
    (d) => {
      d.statusCodeDistribution = { 200: 100, 422: 1 }
    },
    (d) => {
      d.errorDistribution = { timeout: 1 }
    },
    (d) => {
      d.summary.requestsPerSec = 0
    },
    (d) => {
      d.latencyPercentiles.p99 = null
    },
  ]) {
    const data = valid()
    mutate(data)
    assert.throws(() => parseOha(JSON.stringify(data), 100))
  }
})
test("CPU attribution weights sample durations and excludes idle and inspector control", () => {
  const frame = (id, functionName, url = "app.js") => ({
    id,
    callFrame: { functionName, url, lineNumber: 0 },
  })
  const result = summarize(
    {
      nodes: [
        frame(1, "(idle)"),
        frame(2, "post", "node:inspector"),
        frame(3, "handler"),
        frame(4, "serialize"),
      ],
      samples: [1, 2, 3, 4, 3],
      timeDeltas: [900, 900, 100, 200, 100],
    },
    "cpu",
  )
  assert.equal(result.total, 400)
  assert.equal(result.top.length, 2)
  assert.equal(result.top[0].share, 0.5)
})
test("heap attribution sums sampled self sizes without double-counting descendants", () => {
  const node = (functionName, selfSize, children = []) => ({
    callFrame: { functionName, url: "app.js", lineNumber: 0 },
    selfSize,
    children,
  })
  const result = summarize(
    { head: node("root", 0, [node("context", 160, [node("headers", 80)]), node("context", 160)]) },
    "heap",
  )
  assert.equal(result.total, 400)
  assert.equal(result.top[0].value, 320)
})
