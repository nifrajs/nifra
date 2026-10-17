export interface ProxyMeasure {
  readonly rps: number
  readonly p50ms: number
  readonly p99ms: number
}

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined
}

export function parseProxyOha(raw: string): ProxyMeasure {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error("oha: proxy output was not JSON")
  }
  const success = finiteNumber(field(field(value, "summary"), "successRate"))
  const statuses = field(value, "statusCodeDistribution")
  const ok = finiteNumber(field(statuses, "200")) ?? 0
  const otherStatuses =
    typeof statuses === "object" &&
    statuses !== null &&
    Object.keys(statuses).some((status) => status !== "200" && field(statuses, status) !== 0)
  if (success !== 1 || ok <= 0 || otherStatuses) {
    throw new Error(`oha: invalid proxy sample (successRate=${success}, HTTP 200=${ok})`)
  }
  const rps = finiteNumber(field(field(value, "summary"), "requestsPerSec"))
  const latencies = field(value, "latencyPercentiles")
  const p50 = finiteNumber(field(latencies, "p50"))
  const p99 = finiteNumber(field(latencies, "p99"))
  if (rps === undefined || p50 === undefined || p99 === undefined) {
    throw new Error("oha: unexpected proxy JSON measurement shape")
  }
  return { rps: Math.round(rps), p50ms: p50 * 1000, p99ms: p99 * 1000 }
}
