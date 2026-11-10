import type { CacheEntry, RecordedAction } from "./cache.ts"
import { targetSelector } from "./decision.ts"
import { type Clock, E2EError, type Engine, type Selector } from "./engine.ts"
import { checkEvidence, type EvidenceCheck } from "./evidence.ts"
import { fillUnique, forPage, type Params } from "./params.ts"
import { normalizeRoute } from "./route.ts"

/** Why a replay stopped short of finishing the recorded actions. */
export type StopReason =
  | "target-not-found"
  | "ambiguous"
  | "end-mismatch"
  | "action-uncertain"
  | "route-mismatch"

export type ReplayOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly reason: StopReason
      readonly detail: string
      /** The actions that did run, in order; the one that stopped the replay is not among them. */
      readonly performed: readonly RecordedAction[]
    }

export interface ReplayDeps {
  readonly engine: Engine
  readonly clock: Clock
  readonly pollInterval: number
  readonly actionTimeout: number
  /** Origin of the app under test, so the port does not count as part of a route. */
  readonly origin: string
  readonly navigate: (path: string) => Promise<void>
  /** The redacted, unpruned outline of the page. */
  readonly observe: () => Promise<string>
}

export function withoutNth(selector: Selector): Selector {
  return selector.filter((step) => step.kind !== "nth")
}

export async function visibleCount(engine: Engine, selector: Selector): Promise<number> {
  return (await engine.resolve(selector)).filter((state) => state.visible).length
}

/**
 * Re-run recorded actions with no model. Each control is found by the same role, name, label, text
 * or test id it had when recorded and must match exactly as often as it did then: a replay that
 * cannot find its target, or finds more than it should, stops rather than tap a near miss.
 */
export async function replayEntry(
  deps: ReplayDeps,
  entry: CacheEntry,
  params: Params,
): Promise<ReplayOutcome> {
  const { engine, clock } = deps
  const performed: RecordedAction[] = []
  const stop = (reason: StopReason, detail: string): ReplayOutcome => ({
    ok: false,
    reason,
    detail,
    performed,
  })

  const start = normalizeRoute(await engine.url(), deps.origin)
  if (start !== entry.startRoute) {
    return stop("route-mismatch", `started at ${start}, recorded at ${entry.startRoute}`)
  }

  for (const action of entry.actions) {
    if (action.kind === "goto") {
      try {
        await deps.navigate(forPage(action.path, params))
      } catch (error) {
        if (error instanceof E2EError || error instanceof TypeError) {
          return stop("action-uncertain", `goto ${action.path} failed: ${error.message}`)
        }
        throw error
      }
      performed.push(action)
      continue
    }

    const selector = targetSelector(action.target)
    if (action.target.nth !== undefined) {
      const settled = await settleMatches(deps, withoutNth(selector), action.matches)
      if (settled !== undefined) return stop(settled.reason, settled.detail)
    }
    try {
      if (action.kind === "tap") {
        await engine.act(selector, { kind: "tap" }, deps.actionTimeout)
      } else if (action.kind === "fill") {
        await engine.act(
          selector,
          { kind: "fill", value: forPage(action.value, params) },
          deps.actionTimeout,
        )
      } else {
        await engine.act(selector, { kind: "press", key: action.key }, deps.actionTimeout)
      }
    } catch (error) {
      if (!(error instanceof E2EError)) throw error
      const what = `${action.kind} ${JSON.stringify(action.target)}`
      if (error.code === "LOCATOR_NOT_FOUND")
        return stop("target-not-found", `${what}: ${error.message}`)
      if (error.code === "LOCATOR_AMBIGUOUS") return stop("ambiguous", `${what}: ${error.message}`)
      return stop("action-uncertain", `${what}: ${error.message}`)
    }
    performed.push(action)
  }

  const deadline = clock.now() + deps.actionTimeout
  for (;;) {
    const route = normalizeRoute(await engine.url(), deps.origin)
    const snapshot = await deps.observe()
    let evidence: EvidenceCheck
    if (route === entry.end.route) {
      evidence = checkEvidence(
        {
          appeared: entry.end.appeared.map((line) => fillUnique(line, params)),
          disappeared: entry.end.disappeared.map((line) => fillUnique(line, params)),
        },
        snapshot,
      )
    } else {
      evidence = { ok: false, detail: `ended at ${route}, recorded ${entry.end.route}` }
    }
    if (evidence.ok) return { ok: true }
    const remaining = deadline - clock.now()
    if (remaining <= 0) return stop("end-mismatch", evidence.detail)
    await clock.sleep(Math.min(deps.pollInterval, remaining))
  }
}

/** Waits for `selector` to match `expected` visible elements; the stop it ends in otherwise. */
async function settleMatches(
  deps: ReplayDeps,
  selector: Selector,
  expected: number,
): Promise<{ reason: StopReason; detail: string } | undefined> {
  const deadline = deps.clock.now() + deps.actionTimeout
  for (;;) {
    const count = await visibleCount(deps.engine, selector)
    if (count === expected) return undefined
    const remaining = deadline - deps.clock.now()
    if (remaining <= 0) {
      return count === 0
        ? { reason: "target-not-found", detail: "no visible element matches the recorded target" }
        : { reason: "ambiguous", detail: `${count} elements match, ${expected} did when recorded` }
    }
    await deps.clock.sleep(Math.min(deps.pollInterval, remaining))
  }
}
