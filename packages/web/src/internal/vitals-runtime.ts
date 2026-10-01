/**
 * The measuring half of `@nifrajs/web/vitals`. It takes the metric library as a parameter, so tests run
 * it against a fake; the public entry passes Google's `web-vitals`. Kept off `@nifrajs/web/client`: an
 * app that never reports vitals ships none of it.
 */
import type { MetricType, ReportOpts } from "web-vitals"
import { getBrowserRouter } from "../navigation.ts"
import type { ReportWebVitalsOptions, WebVitalsMetric } from "../vitals.ts"

type OnMetric = (report: (metric: MetricType) => void, options?: ReportOpts) => void

/** The `web-vitals` functions the reporter registers with. */
export interface VitalsLibrary {
  readonly onCLS: OnMetric
  readonly onFCP: OnMetric
  readonly onINP: OnMetric
  readonly onLCP: OnMetric
  readonly onTTFB: OnMetric
}

/** The route id a measured URL matches, through the router `installHistory` registered. A metric of a
 * client navigation names that navigation's URL; any other names the document's, and a library that
 * names none falls back to the current one. */
function routeOf(url: string | undefined): string | undefined {
  const router = getBrowserRouter()
  if (router === undefined) return undefined
  const target = new URL(url ?? location.href, location.href)
  if (target.origin !== location.origin) return undefined
  return router.match(target.pathname + target.search)?.routeId
}

/** Register `report` with every metric `library` measures. Each report is a fresh object, so a metric
 * kept by the caller does not change when the library updates its own copy. On the server there is
 * nothing to measure, and the returned stop function is a no-op. */
export function reportWith(
  library: VitalsLibrary,
  report: (metric: WebVitalsMetric) => void,
  options: ReportWebVitalsOptions,
): () => void {
  if (typeof document === "undefined") return () => {}
  let active = true
  const opts: ReportOpts = {
    reportAllChanges: options.reportAllChanges === true,
    reportSoftNavs: options.softNavigations === true,
  }
  const forward = (metric: MetricType): void => {
    if (active) report({ ...metric, route: routeOf(metric.navigationURL) })
  }
  library.onCLS(forward, opts)
  library.onFCP(forward, opts)
  library.onINP(forward, opts)
  library.onLCP(forward, opts)
  library.onTTFB(forward, opts)
  return () => {
    active = false
  }
}
