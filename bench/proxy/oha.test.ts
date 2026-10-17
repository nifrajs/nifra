import { expect, test } from "bun:test"
import { parseProxyOha } from "./oha.ts"

const sample = (successRate: number, statuses: Record<string, number>) =>
  JSON.stringify({
    summary: { requestsPerSec: 1000, successRate },
    latencyPercentiles: { p50: 0.001, p99: 0.005 },
    statusCodeDistribution: statuses,
  })

test("proxy samples accept only fully successful HTTP 200 traffic", () => {
  expect(parseProxyOha(sample(1, { "200": 1000 }))).toEqual({ rps: 1000, p50ms: 1, p99ms: 5 })
  expect(() => parseProxyOha(sample(0.995, { "200": 995 }))).toThrow("invalid proxy sample")
  expect(() => parseProxyOha(sample(1, { "200": 999, "500": 1 }))).toThrow("invalid proxy sample")
  expect(() => parseProxyOha(sample(0, {}))).toThrow("invalid proxy sample")
})
