/**
 * Framework-neutral async boundaries. A boundary owns one named piece of UI data; the web core owns
 * lifecycle, concurrency, and isolation while each adapter decides how its `render` result is mounted.
 * The contract deliberately contains no React/Svelte/Vue/Preact types.
 */

/** Request-scoped inputs available to dynamic and intercepting boundaries. */
export interface BoundaryRequestCtx {
  readonly request: Request
  readonly params: Readonly<Record<string, string>>
  readonly api: unknown
  readonly env: unknown
  readonly draft: boolean
  readonly search: Readonly<Record<string, unknown>>
  readonly signal: AbortSignal
}

/** Build-safe inputs available to a static boundary. It intentionally has no request/session/params API. */
export interface StaticCtx {
  readonly phase: "build"
  readonly origin?: string
}

export type BoundaryMode = "static" | "dynamic" | { readonly intercept: string }

interface BoundaryBase<Data, UI> {
  readonly name: string
  readonly render: (data: Data) => UI
  readonly fallback?: UI
  /** Adapter-provided error slot name. The neutral core never imports a UI component. */
  readonly errorId?: string
}

export type StaticBoundary<Data, UI> = BoundaryBase<Data, UI> & {
  readonly mode: "static"
  readonly load?: (ctx: StaticCtx) => Data | Promise<Data>
}

export type DynamicBoundary<Data, UI> = BoundaryBase<Data, UI> & {
  readonly mode: "dynamic"
  readonly load?: (ctx: BoundaryRequestCtx) => Data | Promise<Data>
}

export type InterceptBoundary<Data, UI> = BoundaryBase<Data, UI> & {
  readonly mode: { readonly intercept: string }
  readonly load?: (ctx: BoundaryRequestCtx) => Data | Promise<Data>
}

/** A discriminated union: the `mode` selects the context type accepted by `load`. */
export type Boundary<Data, UI> =
  | StaticBoundary<Data, UI>
  | DynamicBoundary<Data, UI>
  | InterceptBoundary<Data, UI>

/**
 * Erased runtime registration shape used by a route/layout manifest. This is intentionally a
 * structural union rather than `Boundary<never, unknown>`: a registration keeps its loader's
 * concrete data type at the declaration site, and function-parameter variance must not turn that
 * loader into `Promise<never>` when the manifest erases it.
 */
type ErasedBoundaryBase = {
  readonly name: string
  readonly render: (data: never) => unknown
  readonly fallback?: unknown
  readonly errorId?: string
}

export type BoundaryRegistration =
  | (ErasedBoundaryBase & {
      readonly mode: "static"
      readonly load?: (ctx: StaticCtx) => unknown | Promise<unknown>
    })
  | (ErasedBoundaryBase & {
      readonly mode: "dynamic"
      readonly load?: (ctx: BoundaryRequestCtx) => unknown | Promise<unknown>
    })
  | (ErasedBoundaryBase & {
      readonly mode: { readonly intercept: string }
      readonly load?: (ctx: BoundaryRequestCtx) => unknown | Promise<unknown>
    })

/** Neutral manifest descriptor: no framework component crosses the web core boundary. */
export interface BoundaryDescriptor {
  readonly name: string
  readonly mode: BoundaryMode
  readonly hasLoad: boolean
  readonly errorId?: string
}

export type BoundaryStatus = "unresolved" | "pending" | "ready" | "error"

export interface BoundaryError {
  readonly name: string
  readonly message: string
}

/** Serializable boundary state passed to the adapter's render seam. */
export interface BoundaryState {
  readonly name: string
  readonly mode: BoundaryMode
  readonly status: BoundaryStatus
  readonly data?: unknown
  readonly error?: BoundaryError
  readonly errorId?: string
}

export type BoundaryStates = Readonly<Record<string, BoundaryState>>

/** A dynamic load that has started but is not part of the initial render barrier. */
export interface PendingBoundary {
  readonly name: string
  readonly mode: BoundaryMode
  readonly errorId?: string
  readonly promise: Promise<unknown>
}

/** Runtime handles for a concurrent boundary batch. `initial` is renderable immediately. */
export interface DynamicBoundaryBatch {
  readonly initial: BoundaryStates
  readonly pending: ReadonlyArray<PendingBoundary>
  /** Resolves to final per-boundary states for non-streaming consumers and tests. */
  readonly complete: Promise<BoundaryStates>
}

/** Public in-memory reference cache for build-safe static boundary values. It holds no payload outside
 * the process and is intentionally not a durable or tenant-aware cache implementation. */
export interface StaticBoundaryCache {
  get(boundary: BoundaryRegistration): Promise<unknown> | undefined
  set(boundary: BoundaryRegistration, value: Promise<unknown>): void
}

export class MemoryStaticBoundaryCache implements StaticBoundaryCache {
  readonly #values = new WeakMap<object, Promise<unknown>>()

  get(boundary: BoundaryRegistration): Promise<unknown> | undefined {
    return this.#values.get(boundary as object)
  }

  set(boundary: BoundaryRegistration, value: Promise<unknown>): void {
    this.#values.set(boundary as object, value)
  }
}

export interface StaticBoundaryImportEdge {
  readonly from: string
  readonly to: string
}

export interface StaticBoundaryRoot {
  readonly name: string
  readonly module: string
}

/**
 * Enforce the second half of the static-boundary safety boundary. A build adapter supplies the
 * transitive module graph and the modules it has classified as request-scoped; a static root that
 * reaches one fails before any shared shell is emitted. Keeping this check graph-shaped makes it
 * usable by Bun/Vite without making the neutral web runtime depend on either bundler.
 */
export function assertStaticBoundaryImports(
  roots: readonly StaticBoundaryRoot[],
  edges: readonly StaticBoundaryImportEdge[],
  requestScopedModules: ReadonlySet<string>,
): void {
  const next = new Map<string, string[]>()
  for (const edge of edges) {
    const children = next.get(edge.from)
    if (children === undefined) next.set(edge.from, [edge.to])
    else children.push(edge.to)
  }
  for (const root of roots) {
    const seen = new Set<string>([root.module])
    const queue = [root.module]
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const module = queue[cursor]
      if (module === undefined) continue
      if (requestScopedModules.has(module)) {
        throw new TypeError(
          `[nifra/web] static boundary "${root.name}" reaches request-scoped module "${module}"`,
        )
      }
      for (const child of next.get(module) ?? []) {
        if (!seen.has(child)) {
          seen.add(child)
          queue.push(child)
        }
      }
    }
  }
}

const BOUNDARY_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const MAX_INTERCEPT_PATH = 2048

const modeKey = (mode: BoundaryMode): string =>
  typeof mode === "string" ? mode : `intercept:${mode.intercept}`

const assertMode = (mode: BoundaryMode): void => {
  if (mode === "static" || mode === "dynamic") return
  if (
    typeof mode !== "object" ||
    mode === null ||
    typeof mode.intercept !== "string" ||
    mode.intercept.length === 0 ||
    mode.intercept.length > MAX_INTERCEPT_PATH ||
    !mode.intercept.startsWith("/") ||
    mode.intercept.startsWith("//")
  ) {
    throw new TypeError("[nifra/web] boundary intercept must be a same-origin path")
  }
}

/** Validate and serialize the neutral boundary manifest. Duplicate names fail closed at startup. */
export function boundaryDescriptors(
  boundaries: readonly BoundaryRegistration[],
): ReadonlyArray<BoundaryDescriptor> {
  const seen = new Set<string>()
  return boundaries.map((boundary) => {
    if (!BOUNDARY_NAME.test(boundary.name) || seen.has(boundary.name)) {
      throw new TypeError(`[nifra/web] invalid or duplicate boundary name "${boundary.name}"`)
    }
    assertMode(boundary.mode)
    seen.add(boundary.name)
    return {
      name: boundary.name,
      mode: boundary.mode,
      hasLoad: boundary.load !== undefined,
      ...(boundary.errorId !== undefined ? { errorId: boundary.errorId } : {}),
    }
  })
}

const scopedContext = (context: BoundaryRequestCtx): BoundaryRequestCtx =>
  Object.freeze({
    request: context.request,
    params: Object.freeze({ ...context.params }),
    api: context.api,
    env: context.env,
    draft: context.draft,
    search: Object.freeze({ ...context.search }),
    signal: context.signal,
  })

const boundaryError = (error: unknown): BoundaryError => {
  if (error instanceof Error) return { name: error.name, message: error.message }
  return { name: "Error", message: "Boundary failed" }
}

/**
 * Resolve all dynamic boundaries concurrently. Each receives a fresh frozen context object; one
 * failure becomes that boundary's error state and never rejects a sibling or exposes sibling data.
 * Static/intercepting modes remain `unresolved` until their phase-specific runtime owns them.
 */
export async function resolveDynamicBoundaries(
  boundaries: readonly BoundaryRegistration[],
  context: BoundaryRequestCtx,
): Promise<BoundaryStates> {
  return startDynamicBoundaries(boundaries, context).complete
}

/**
 * Start all dynamic boundary loads at once without making the page wait for the slowest sibling.
 * The initial states contain `status: "pending"`; callers that support deferred values can attach
 * each `pending.promise` to its own slot. `complete` still provides settled, isolated states to
 * non-streaming callers, preserving the simple reference API.
 */
export function startDynamicBoundaries(
  boundaries: readonly BoundaryRegistration[],
  context: BoundaryRequestCtx,
): DynamicBoundaryBatch {
  const descriptors = boundaryDescriptors(boundaries)
  const initial: Record<string, BoundaryState> = {}
  const pending: PendingBoundary[] = []

  for (const [index, boundary] of boundaries.entries()) {
    if (descriptors[index] === undefined) continue
    const base = {
      name: boundary.name,
      mode: boundary.mode,
      ...(boundary.errorId !== undefined ? { errorId: boundary.errorId } : {}),
    }
    if (boundary.mode !== "dynamic") {
      initial[boundary.name] = { ...base, status: "unresolved" }
      continue
    }
    if (boundary.load === undefined) {
      initial[boundary.name] = { ...base, status: "ready" }
      continue
    }
    // Promise.resolve().then() converts a synchronous throw into this boundary's rejection, so it
    // cannot abort siblings or escape before the caller attaches the deferred consumer.
    const promise = Promise.resolve().then(() => boundary.load?.(scopedContext(context)))
    pending.push({
      name: boundary.name,
      mode: boundary.mode,
      ...(boundary.errorId !== undefined ? { errorId: boundary.errorId } : {}),
      promise,
    })
    initial[boundary.name] = { ...base, status: "pending" }
  }

  const complete = Promise.all(
    boundaries.map(async (boundary) => {
      const base = {
        name: boundary.name,
        mode: boundary.mode,
        ...(boundary.errorId !== undefined ? { errorId: boundary.errorId } : {}),
      }
      if (boundary.mode !== "dynamic") return { ...base, status: "unresolved" as const }
      if (boundary.load === undefined) return { ...base, status: "ready" as const }
      const load = pending.find((entry) => entry.name === boundary.name)
      if (load === undefined)
        return { ...base, status: "error" as const, error: boundaryError(undefined) }
      try {
        const data = await load.promise
        return { ...base, status: "ready" as const, ...(data !== undefined ? { data } : {}) }
      } catch (error) {
        return { ...base, status: "error" as const, error: boundaryError(error) }
      }
    }),
  ).then((states) => Object.fromEntries(states.map((state) => [state.name, state])))

  return { initial, pending, complete }
}

/**
 * Resolve only explicitly annotated static boundaries with a request-free build context. Dynamic
 * and intercepting boundaries remain unresolved. Values are cached by boundary object identity in
 * the supplied in-memory cache, so a worker instance does not repeat a build-safe computation per
 * request. A rejected static load becomes that slot's error state; it never fabricates shared data.
 */
export async function resolveStaticBoundaries(
  boundaries: readonly BoundaryRegistration[],
  context: StaticCtx,
  cache: StaticBoundaryCache = DEFAULT_STATIC_CACHE,
): Promise<BoundaryStates> {
  const descriptors = boundaryDescriptors(boundaries)
  const states = await Promise.all(
    boundaries.map(async (boundary, index) => {
      if (descriptors[index] === undefined || boundary.mode !== "static") {
        return {
          name: boundary.name,
          mode: boundary.mode,
          status: "unresolved" as const,
          ...(boundary.errorId !== undefined ? { errorId: boundary.errorId } : {}),
        }
      }
      if (boundary.load === undefined) {
        return {
          name: boundary.name,
          mode: boundary.mode,
          status: "ready" as const,
          ...(boundary.errorId !== undefined ? { errorId: boundary.errorId } : {}),
        }
      }
      let value = cache.get(boundary)
      if (value === undefined) {
        value = Promise.resolve().then(() => boundary.load?.(context))
        cache.set(boundary, value)
      }
      try {
        const data = await value
        return {
          name: boundary.name,
          mode: boundary.mode,
          status: "ready" as const,
          ...(data !== undefined ? { data } : {}),
          ...(boundary.errorId !== undefined ? { errorId: boundary.errorId } : {}),
        }
      } catch (error) {
        return {
          name: boundary.name,
          mode: boundary.mode,
          status: "error" as const,
          error: boundaryError(error),
          ...(boundary.errorId !== undefined ? { errorId: boundary.errorId } : {}),
        }
      }
    }),
  )
  return Object.fromEntries(states.map((state) => [state.name, state]))
}

const DEFAULT_STATIC_CACHE = new MemoryStaticBoundaryCache()

/** Stable mode label for adapter registries and diagnostics. */
export function boundaryModeKey(mode: BoundaryMode): string {
  return modeKey(mode)
}
