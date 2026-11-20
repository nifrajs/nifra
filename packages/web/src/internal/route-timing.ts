/** Milliseconds of work before the initial response. Layout and page loaders can overlap. */
export type RoutePhase = "pageLoader" | "layoutLoaders" | "validation" | "serialization" | "render"

export type RouteTiming = (phase: RoutePhase, elapsedMs: number) => void

export type RouteTimingFor = (route: string, request: Request) => RouteTiming | undefined

type LoaderPhase = "pageLoader" | "layoutLoaders"
interface LoaderTiming {
  readonly timing: RouteTiming
  readonly phase: LoaderPhase
}

const timedContexts = new WeakMap<object, LoaderTiming>()
const guardedLoaders = new WeakSet<object>()

export function registerTimedLoader(loader: object): void {
  guardedLoaders.add(loader)
}

export function loaderTimingOf(ctx: unknown): LoaderTiming | undefined {
  return typeof ctx === "object" && ctx !== null ? timedContexts.get(ctx) : undefined
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

/** Mark the final loader context so the output guard can time the two phases independently. */
export function invokeLoader<C extends object>(
  loader: (ctx: C) => unknown,
  ctx: C,
  timing: RouteTiming | undefined,
  phase: LoaderPhase,
): unknown {
  if (timing === undefined) return loader(ctx)
  if (!guardedLoaders.has(loader)) {
    return measureRoutePhase(timing, phase, () => timedLoaderResult(() => loader(ctx)))
  }
  timedContexts.set(ctx, { timing, phase })
  return loader(ctx)
}
