import { definePlugin } from "@nifrajs/core"
import { withHeaders } from "./_utils.ts"

export interface TimingMetric {
  readonly name: string
  readonly duration: number
  readonly description?: string
}

export interface TimingControls {
  mark(name: string): void
  measure(name: string, start: string, end?: string): void
  metric(name: string, duration: number, description?: string): void
}

export interface TimingOptions {
  /** Name for the automatic total request metric. Default `"total"`; set `false` to disable. */
  readonly total?: string | false
  /** Decimal places for durations. Default `1`. */
  readonly precision?: number
  /** Only emit timing for matching requests. Default `true`. */
  readonly enabled?: boolean | ((request: Request) => boolean)
}

interface TimingState {
  readonly start: number
  readonly marks: Map<string, number>
  readonly metrics: TimingMetric[]
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

function assertMetricName(name: string): void {
  if (!TOKEN.test(name)) throw new Error(`timing: invalid metric name "${name}"`)
}

function assertDuration(duration: number): void {
  if (!Number.isFinite(duration) || duration < 0) {
    throw new Error("timing: duration must be a finite non-negative number")
  }
}

function quoteDescription(value: string): string {
  let out = ""
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) continue
    const ch = value[i] ?? ""
    out += ch === "\\" || ch === '"' ? `\\${ch}` : ch
  }
  return out
}

function formatMetric(metric: TimingMetric, precision: number): string {
  let out = `${metric.name};dur=${metric.duration.toFixed(precision)}`
  if (metric.description !== undefined) out += `;desc="${quoteDescription(metric.description)}"`
  return out
}

/**
 * Adds a `Server-Timing` response header and typed `c.timing` controls for custom metrics.
 * Put request-rewriting middleware (for example `methodOverride`) before `timing()` so timing is
 * attached to the final routed request.
 */
export function timing(options: TimingOptions = {}) {
  const totalName = options.total === undefined ? "total" : options.total
  if (totalName !== false) assertMetricName(totalName)
  const precision = options.precision ?? 1
  if (!Number.isInteger(precision) || precision < 0 || precision > 6) {
    throw new Error("timing: precision must be an integer from 0 to 6")
  }
  const enabled = options.enabled ?? true
  const isEnabled = typeof enabled === "function" ? enabled : enabled ? () => true : () => false
  const states = new WeakMap<Request, TimingState>()

  const controls = (req: Request): TimingControls => ({
    mark(name) {
      assertMetricName(name)
      const state = states.get(req)
      if (state !== undefined) state.marks.set(name, performance.now())
    },
    measure(name, start, end) {
      assertMetricName(name)
      const state = states.get(req)
      if (state === undefined) return
      const startAt = state.marks.get(start)
      const endAt = end === undefined ? performance.now() : state.marks.get(end)
      if (startAt === undefined || endAt === undefined) {
        throw new Error("timing: unknown mark")
      }
      const duration = endAt - startAt
      assertDuration(duration)
      state.metrics.push({ name, duration })
    },
    metric(name, duration, description) {
      assertMetricName(name)
      assertDuration(duration)
      const state = states.get(req)
      if (state !== undefined) {
        state.metrics.push(
          description === undefined ? { name, duration } : { name, duration, description },
        )
      }
    },
  })

  return definePlugin("timing", (app) =>
    app
      .onRequest((req) => {
        if (!isEnabled(req)) return undefined
        states.set(req, { start: performance.now(), marks: new Map(), metrics: [] })
        return undefined
      })
      .derive((c) => ({ timing: controls(c.req) }))
      .onResponse((res, req) => {
        const state = states.get(req)
        if (state === undefined) return res
        states.delete(req)

        const metrics =
          totalName === false
            ? state.metrics
            : [{ name: totalName, duration: performance.now() - state.start }, ...state.metrics]
        if (metrics.length === 0) return res

        const value = metrics.map((metric) => formatMetric(metric, precision)).join(", ")
        return withHeaders(res, (headers) => {
          const existing = headers.get("server-timing")
          headers.set("server-timing", existing === null ? value : `${existing}, ${value}`)
        })
      }),
  )
}
