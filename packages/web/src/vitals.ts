/**
 * `@nifrajs/web/vitals` - Core Web Vitals (LCP, INP, CLS, FCP and TTFB) measured in your users'
 * browsers by Google's `web-vitals`, an optional peer dependency (`bun add web-vitals`). Each metric
 * arrives with the id of the route it belongs to, so field data groups by route.
 *
 * Call {@link reportWebVitals} once in the browser, from a root layout's mount effect. It returns a
 * function that stops reporting, which is what a mount effect's cleanup wants:
 *
 * ```ts
 * import { reportWebVitals } from "@nifrajs/web/vitals"
 *
 * reportWebVitals((metric) => {
 *   const body = JSON.stringify({ name: metric.name, value: metric.value, route: metric.route })
 *   void fetch("/api/vitals", { method: "POST", body, keepalive: true })
 * })
 * ```
 */
import type { MetricType } from "web-vitals"
import { onCLS, onFCP, onINP, onLCP, onTTFB } from "web-vitals"
import { reportWith } from "./internal/vitals-runtime.ts"

/**
 * One measurement from `web-vitals` - `name` is `"LCP"`, `"INP"`, `"CLS"`, `"FCP"` or `"TTFB"`, with its
 * `value`, `rating` (`"good"`, `"needs-improvement"` or `"poor"`), `delta` since the last report and an
 * `id` unique to the measurement - plus the route it belongs to.
 */
export type WebVitalsMetric = MetricType & {
  /** The id of the route the measured page matched (`users/[id]`, the id `useMatches` reports).
   * `undefined` before the router mounts, for a page no route matches, or for another origin. */
  readonly route: string | undefined
}

/** How {@link reportWebVitals} reports. */
export interface ReportWebVitalsOptions {
  /** Report every change to a metric (LCP, CLS and INP grow while the page is open), not only the
   * value it settles on. Use `delta` or `id` to aggregate. Default `false`. */
  readonly reportAllChanges?: boolean
  /** Measure each client-side navigation as a page view of its own where the browser can (Chromium
   * 151 and later), so its metrics carry the route it navigated to. The first page's metrics then
   * settle at the first client navigation; other browsers report as if this were off. Default `false`. */
  readonly softNavigations?: boolean
}

const library = { onCLS, onFCP, onINP, onLCP, onTTFB }

/**
 * Report the page's Core Web Vitals to `report`, each with the route it belongs to. A metric is
 * reported once its value is final - FCP and TTFB as soon as they are known, LCP at the first
 * interaction or when the page is hidden, CLS and INP when the page is hidden - unless
 * `reportAllChanges` asks for every change. The browser buffers the load metrics recorded before the
 * call, so a mount effect after hydration is early enough.
 *
 * Returns a function that stops reporting. On the server it does nothing.
 */
export function reportWebVitals(
  report: (metric: WebVitalsMetric) => void,
  options: ReportWebVitalsOptions = {},
): () => void {
  return reportWith(library, report, options)
}
