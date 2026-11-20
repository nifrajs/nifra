/** Milliseconds of work before the initial response. Layout and page loaders can overlap. */
export type RoutePhase = "pageLoader" | "layoutLoaders" | "validation" | "serialization" | "render"

export type RouteTiming = (phase: RoutePhase, elapsedMs: number) => void

export type RouteTimingFor = (route: string, request: Request) => RouteTiming | undefined

export type LoaderPhase = "pageLoader" | "layoutLoaders"
export const TIMED_LOADER = Symbol("nifra.web.timed-loader")

type Loader<C> = ((ctx: C) => unknown) & {
  readonly [TIMED_LOADER]?: (timing: RouteTiming, phase: LoaderPhase, ctx: C) => unknown
}

export function measureRoutePhase<T>(timing: RouteTiming, phase: RoutePhase, run: () => T): T {
  const started = performance.now()
  const finish = () => timing(phase, performance.now() - started)
  try {
    const value = run()
    if (value instanceof Promise) {
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The replacement promise settles with the same value or error.
      return value.finally(finish) as T
    }
    finish()
    return value
  } catch (error) {
    finish()
    throw error
  }
}

export function timedLoaderResult(run: () => unknown): unknown {
  const value = run()
  return value !== null && (typeof value === "object" || typeof value === "function")
    ? Promise.resolve(value)
    : value
}

/** A guarded loader can measure its application code and its output guard separately. */
export function invokeLoader<C extends object>(
  loader: Loader<C>,
  ctx: C,
  timing: RouteTiming | undefined,
  phase: LoaderPhase,
): unknown {
  if (timing === undefined) return loader(ctx)
  const measured = loader[TIMED_LOADER]
  return measured === undefined
    ? measureRoutePhase(timing, phase, () => timedLoaderResult(() => loader(ctx)))
    : measured(timing, phase, ctx)
}
