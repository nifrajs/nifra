import { definePlugin } from "@nifrajs/core"

type MaybePromise<T> = T | Promise<T>

export interface HealthcheckOptions {
  /** Liveness path — always `200` while the process is up. Default `"/health"`. */
  readonly path?: string
  /** Readiness path — runs `checks`; `200` if all pass, `503` otherwise. Default `"/ready"`. */
  readyPath?: string
  /** Readiness checks (DB ping, cache reachable, …). Each returns a boolean or throws; a throw counts
   * as failing. `/ready` reports each by name and is `200` only when all pass. */
  readonly checks?: Readonly<Record<string, () => MaybePromise<boolean>>>
}

const noStore = { "cache-control": "no-store" } as const

/**
 * Register **liveness** (`/health`) and **readiness** (`/ready`) endpoints. Liveness is a flat `200`
 * (the process is serving). Readiness runs each `check` and returns `200 { status: "ok", checks }`
 * when all pass, or `503 { status: "error", checks }` when any fail (a thrown check counts as failed).
 * Both are `Cache-Control: no-store`.
 *
 * Apply it **before** auth guards so the endpoints stay public (`beforeHandle` is order-scoped):
 *
 * ```ts
 * app.use(healthcheck({ checks: { db: () => db.ping() } })).use(bearer({ verify }))
 * ```
 */
export function healthcheck(options: HealthcheckOptions = {}) {
  const path = options.path ?? "/health"
  const readyPath = options.readyPath ?? "/ready"
  const checks = options.checks ?? {}
  const checkNames = Object.keys(checks)
  return definePlugin("healthcheck", (app) => {
    app.register("GET", path, undefined, () =>
      Response.json({ status: "ok" }, { headers: noStore }),
    )
    app.register("GET", readyPath, undefined, async () => {
      const results: Record<string, boolean> = {}
      let ready = true
      // Run checks concurrently; a throw (or false) marks that check — and the whole probe — not ready.
      await Promise.all(
        checkNames.map(async (name) => {
          try {
            results[name] = (await checks[name]?.()) === true
          } catch {
            results[name] = false
          }
          if (!results[name]) ready = false
        }),
      )
      return Response.json(
        { status: ready ? "ok" : "error", checks: results },
        { status: ready ? 200 : 503, headers: noStore },
      )
    })
    return app
  })
}
