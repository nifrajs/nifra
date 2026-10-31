import type { StandardSchemaV1 } from "@nifrajs/core/server"
import type { BoundaryStates } from "../boundary.ts"
import { onIdentityChange } from "../identity.ts"
import type { MatchChain } from "../render-seam.ts"
import {
  normalizeRouteSlotTarget,
  parseRouteSlots,
  RouteSlotStateError,
  stripRouteSlots,
} from "../route-slots.ts"
import {
  type ClientRouter,
  fetchRouteData,
  isRouteDataEnvelope,
  RouteDataFetchError,
  type RouteMatch,
} from "../router.ts"
import { searchOfChain } from "../search.ts"
import type { ComponentState } from "../server-components/types.ts"

const RUNTIME_KEY = Symbol.for("nifra.web.route-slot-runtime")
const MAX_ACTIVE_SLOT_LOADS = 4
const MAX_QUEUED_SLOT_LOADS = 8

export class RouteSlotLoadError extends Error {
  constructor(readonly code: string) {
    super(`[nifra/web] route-slot ${code}`)
    this.name = "RouteSlotLoadError"
  }
}

type RouteSlotRouter = Pick<ClientRouter, "match" | "loadModule" | "routeSlotsFor" | "routePattern">

export interface RouteSlotRuntime {
  readonly router: RouteSlotRouter
  readonly routes: Readonly<Record<string, readonly unknown[]>>
  readonly searchSchemas:
    | Readonly<Record<string, readonly (StandardSchemaV1 | undefined)[]>>
    | undefined
  readonly matchChains: Readonly<Record<string, MatchChain>> | undefined
}

export interface LoadedRouteSlot {
  readonly routeId: string
  readonly path: string
  readonly params: Record<string, string>
  readonly search: Record<string, unknown>
  readonly data: unknown
  readonly serverComponents?: ComponentState
  readonly layoutData?: readonly unknown[]
  readonly boundaries?: BoundaryStates
  readonly live?: unknown
  /** Parent path binds the loaded view to the authorization context that requested it. */
  readonly parentPath: string
  readonly matchChain?: MatchChain
  readonly chain: readonly unknown[]
}

export type RouteSlotStatus = "idle" | "loading" | "ready" | "error"

export interface RouteSlotSnapshot {
  readonly key?: string
  readonly status: RouteSlotStatus
  readonly content?: LoadedRouteSlot
  readonly error?: string
}

type RouteSlotLoader = (signal: AbortSignal) => Promise<LoadedRouteSlot>
const EMPTY_ROUTE_SLOT_SNAPSHOT: RouteSlotSnapshot = Object.freeze({ status: "idle" })
const ROUTE_SLOT_FOCUS_MIN_INTERVAL_MS = 30_000
const MAX_ROUTE_SLOT_STORES = 16
const routeSlotStores = new Map<string, RouteSlotStore>()

/** One shared lifecycle for every adapter consuming the same parent page and slot name. */
export class RouteSlotStore {
  readonly #onUnused: () => void
  readonly #listeners = new Set<() => void>()
  #snapshot: RouteSlotSnapshot = EMPTY_ROUTE_SLOT_SNAPSHOT
  #key: string | undefined
  #loader: RouteSlotLoader | undefined
  #controller: AbortController | undefined
  #epoch = 0
  #lastFocusRevalidationAt: number | undefined
  #unsubscribeIdentity: (() => void) | undefined
  #focusListener: (() => void) | undefined
  #disposed = false

  constructor(_storeKey: string, onUnused: () => void = () => {}) {
    this.#onUnused = onUnused
  }

  get disposed(): boolean {
    return this.#disposed
  }

  get active(): boolean {
    return this.#listeners.size > 0
  }

  readonly getSnapshot = (): RouteSlotSnapshot => this.#snapshot
  readonly getServerSnapshot = (): RouteSlotSnapshot => EMPTY_ROUTE_SLOT_SNAPSHOT

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) return () => {}
    this.#listeners.add(listener)
    if (this.#listeners.size === 1) this.#attachLifecycleListeners()
    return () => {
      this.#listeners.delete(listener)
      if (this.#listeners.size !== 0) return
      queueMicrotask(() => {
        if (this.#listeners.size !== 0 || this.#disposed) return
        this.dispose()
        this.#onUnused()
      })
    }
  }

  sync(key: string, loader?: RouteSlotLoader, error?: string): void {
    if (this.#disposed) return
    if (this.#key === key) {
      if (error !== undefined && this.#snapshot.status === "error") return
      if (loader === undefined && this.#snapshot.status !== "loading") return
      if (loader !== undefined && this.#snapshot.status !== "idle") return
    }
    this.#abortActive()
    this.#key = key
    this.#loader = loader
    if (error !== undefined) {
      this.#publish({ key, status: "error", error })
      return
    }
    if (loader === undefined) {
      this.#publish({ key, status: "idle" })
      return
    }
    this.#startLoad(key, loader, false)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#abortActive()
    this.#detachLifecycleListeners()
    this.#loader = undefined
    this.#key = undefined
    this.#snapshot = EMPTY_ROUTE_SLOT_SNAPSHOT
    this.#listeners.clear()
  }

  #publish(snapshot: RouteSlotSnapshot): void {
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }

  #abortActive(): void {
    this.#epoch++
    this.#controller?.abort()
    this.#controller = undefined
  }

  #startLoad(key: string, loader: RouteSlotLoader, background: boolean): void {
    const epoch = ++this.#epoch
    const controller = new AbortController()
    const previous = this.#snapshot
    this.#controller = controller
    if (!background) this.#publish({ key, status: "loading" })
    void Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) throw controller.signal.reason
        return loader(controller.signal)
      })
      .then((content) => {
        if (
          !this.#disposed &&
          !controller.signal.aborted &&
          this.#key === key &&
          this.#epoch === epoch
        ) {
          this.#controller = undefined
          this.#publish({ key, status: "ready", content })
        }
      })
      .catch((error: unknown) => {
        if (
          this.#disposed ||
          controller.signal.aborted ||
          this.#key !== key ||
          this.#epoch !== epoch
        )
          return
        this.#controller = undefined
        if (background && previous.content !== undefined) {
          this.#publish({ key, status: "ready", content: previous.content })
          return
        }
        this.#publish({ key, status: "error", error: stableSlotError(error).code })
      })
  }

  #attachLifecycleListeners(): void {
    this.#unsubscribeIdentity = onIdentityChange(() => this.#refreshForIdentityChange())
    if (typeof window !== "undefined") {
      this.#focusListener = () => this.#revalidateOnFocus()
      window.addEventListener("focus", this.#focusListener)
    }
  }

  #detachLifecycleListeners(): void {
    this.#unsubscribeIdentity?.()
    this.#unsubscribeIdentity = undefined
    if (this.#focusListener !== undefined && typeof window !== "undefined")
      window.removeEventListener("focus", this.#focusListener)
    this.#focusListener = undefined
  }

  #refreshForIdentityChange(): void {
    const key = this.#key
    const loader = this.#loader
    if (key === undefined) return
    this.#abortActive()
    this.#publish({ key, status: "idle" })
    if (loader !== undefined) this.#startLoad(key, loader, false)
  }

  refreshForRuntimeChange(): void {
    const key = this.#key
    const loader = this.#loader
    if (key === undefined) return
    this.#abortActive()
    this.#publish({ key, status: "idle" })
    if (loader !== undefined) this.#startLoad(key, loader, false)
  }

  #revalidateOnFocus(): void {
    const now = globalThis.performance.now()
    if (
      this.#lastFocusRevalidationAt !== undefined &&
      now - this.#lastFocusRevalidationAt < ROUTE_SLOT_FOCUS_MIN_INTERVAL_MS
    )
      return
    if (
      this.#key === undefined ||
      this.#loader === undefined ||
      this.#snapshot.status !== "ready" ||
      this.#snapshot.content === undefined ||
      this.#controller !== undefined
    )
      return
    this.#lastFocusRevalidationAt = now
    this.#startLoad(this.#key, this.#loader, true)
  }
}

export function getRouteSlotStore(parentPath: string, name: string): RouteSlotStore {
  const storeKey = JSON.stringify([stripRouteSlots(parentPath), name])
  // Server rendering intentionally sees an empty snapshot and never shares request state globally.
  if (typeof window === "undefined") return new RouteSlotStore(storeKey)
  const existing = routeSlotStores.get(storeKey)
  if (existing !== undefined && !existing.disposed) return existing
  while (routeSlotStores.size >= MAX_ROUTE_SLOT_STORES) {
    let evicted = false
    for (const [key, candidate] of routeSlotStores) {
      if (candidate.active) continue
      candidate.dispose()
      routeSlotStores.delete(key)
      evicted = true
      break
    }
    // Active subscriptions own their stores. The cap applies to idle entries only.
    if (!evicted) break
  }
  const store = new RouteSlotStore(storeKey, () => {
    if (routeSlotStores.get(storeKey) === store) routeSlotStores.delete(storeKey)
  })
  routeSlotStores.set(storeKey, store)
  return store
}

export function routeSlotTargetFromPath(
  path: string,
  name: string,
): { readonly target?: string; readonly error?: string } {
  try {
    const target = parseRouteSlots(path)[name]
    return target === undefined ? {} : { target }
  } catch (error) {
    return { error: error instanceof RouteSlotStateError ? error.code : "malformed" }
  }
}

export function syncRouteSlotStore(
  store: RouteSlotStore,
  parentPath: string,
  name: string,
  target: string | undefined,
  error: string | undefined,
  pending: boolean,
): string {
  const basePath = stripRouteSlots(parentPath)
  const key = routeSlotSyncKey(basePath, name, target, error, pending)
  if (pending) {
    store.sync(key)
    return key
  }
  if (error !== undefined) {
    store.sync(key, undefined, error)
    return key
  }
  if (target === undefined) {
    store.sync(key)
    return key
  }
  store.sync(key, (signal) => {
    const runtime = getRouteSlotRuntime()
    if (runtime === undefined) throw new RouteSlotLoadError("unavailable")
    return loadRouteSlot(runtime, name, basePath, target, signal)
  })
  return key
}

export function routeSlotSyncKey(
  parentPath: string,
  name: string,
  target: string | undefined,
  error: string | undefined,
  pending: boolean,
): string {
  return JSON.stringify([stripRouteSlots(parentPath), name, target ?? null, error ?? null, pending])
}

let active = 0
const queue: Array<() => void> = []

export function setRouteSlotRuntime(runtime: RouteSlotRuntime): void {
  const previous = getRouteSlotRuntime()
  Reflect.set(globalThis, RUNTIME_KEY, runtime)
  const changed =
    previous === undefined ||
    previous.router !== runtime.router ||
    previous.routes !== runtime.routes ||
    previous.searchSchemas !== runtime.searchSchemas ||
    previous.matchChains !== runtime.matchChains
  if (changed) for (const store of routeSlotStores.values()) store.refreshForRuntimeChange()
}

export function onRouteSlotIdentityChange(listener: () => void): () => void {
  return onIdentityChange(listener)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === null || prototype === Object.prototype
  } catch {
    return false
  }
}

function ownDataValue(value: object, key: PropertyKey): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function ownDataEntries(value: unknown): readonly (readonly [string, unknown])[] | undefined {
  if (!isPlainRecord(value)) return undefined
  try {
    const keys = Reflect.ownKeys(value)
    if (keys.some((key) => typeof key !== "string")) return undefined
    const entries: (readonly [string, unknown])[] = []
    for (const key of keys) {
      if (typeof key !== "string") return undefined
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !("value" in descriptor)) return undefined
      entries.push([key, descriptor.value])
    }
    return entries
  } catch {
    return undefined
  }
}

function isFunctionProperty(value: object, key: string): boolean {
  const seen = new Set<object>()
  try {
    let current: object | null = value
    while (current !== null && !seen.has(current)) {
      seen.add(current)
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor !== undefined)
        return "value" in descriptor && typeof descriptor.value === "function"
      current = Object.getPrototypeOf(current)
    }
  } catch {
    return false
  }
  return false
}

function isRouteSlotRouter(value: unknown): value is RouteSlotRouter {
  if (typeof value !== "object" || value === null) return false
  return ["match", "loadModule", "routeSlotsFor", "routePattern"].every((key) =>
    isFunctionProperty(value, key),
  )
}

function isRouteModulesRecord(
  value: unknown,
): value is Readonly<Record<string, readonly unknown[]>> {
  const entries = ownDataEntries(value)
  return entries?.every(([, modules]) => Array.isArray(modules)) ?? false
}

function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  if (!isPlainRecord(value)) return false
  const standard = ownDataValue(value, "~standard")
  if (!isPlainRecord(standard)) return false
  return (
    ownDataValue(standard, "version") === 1 &&
    typeof ownDataValue(standard, "vendor") === "string" &&
    typeof ownDataValue(standard, "validate") === "function"
  )
}

function isSearchSchemaArray(value: unknown): value is readonly (StandardSchemaV1 | undefined)[] {
  if (!Array.isArray(value)) return false
  try {
    return value.every((schema) => schema === undefined || isStandardSchema(schema))
  } catch {
    return false
  }
}

function isSearchSchemaRecord(
  value: unknown,
): value is Readonly<Record<string, readonly (StandardSchemaV1 | undefined)[]>> {
  const entries = ownDataEntries(value)
  return entries?.every(([, schemas]) => isSearchSchemaArray(schemas)) ?? false
}

function isMatchChain(value: unknown): value is MatchChain {
  if (!isPlainRecord(value)) return false
  const ids = ownDataValue(value, "ids")
  const handles = ownDataValue(value, "handles")
  if (!Array.isArray(ids) || !Array.isArray(handles) || ids.length !== handles.length) return false
  try {
    return ids.every((id) => typeof id === "string")
  } catch {
    return false
  }
}

function isMatchChainRecord(value: unknown): value is Readonly<Record<string, MatchChain>> {
  const entries = ownDataEntries(value)
  return entries?.every(([, chain]) => isMatchChain(chain)) ?? false
}

export function getRouteSlotRuntime(): RouteSlotRuntime | undefined {
  const value = ownDataValue(globalThis, RUNTIME_KEY)
  if (!isPlainRecord(value)) return undefined

  const router = ownDataValue(value, "router")
  const routes = ownDataValue(value, "routes")
  const searchSchemas = ownDataValue(value, "searchSchemas")
  const matchChains = ownDataValue(value, "matchChains")

  if (!isRouteSlotRouter(router) || !isRouteModulesRecord(routes)) return undefined
  if (searchSchemas !== undefined && !isSearchSchemaRecord(searchSchemas)) return undefined
  if (matchChains !== undefined && !isMatchChainRecord(matchChains)) return undefined

  return { router, routes, searchSchemas, matchChains }
}

function takeLoadSlot(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  if (active < MAX_ACTIVE_SLOT_LOADS) {
    active++
    return Promise.resolve(() => releaseLoadSlot())
  }
  if (queue.length >= MAX_QUEUED_SLOT_LOADS)
    return Promise.reject(new Error("[nifra/web] route-slot loader concurrency limit exceeded"))
  return new Promise((resolve, reject) => {
    const remove = (): void => {
      const index = queue.indexOf(start)
      if (index >= 0) queue.splice(index, 1)
      signal.removeEventListener("abort", abort)
    }
    const abort = (): void => {
      remove()
      reject(signal.reason)
    }
    const start = (): void => {
      remove()
      active++
      resolve(() => releaseLoadSlot())
    }
    queue.push(start)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
}

function releaseLoadSlot(): void {
  active = Math.max(0, active - 1)
  queue.shift()?.()
}

export async function withRouteSlotConcurrency<T>(
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  const release = await takeLoadSlot(signal)
  try {
    if (signal.aborted) throw signal.reason
    return await work()
  } finally {
    release()
  }
}

function stableSlotError(error: unknown): RouteSlotLoadError {
  if (error instanceof RouteSlotLoadError) return error
  if (error instanceof RouteDataFetchError) {
    const code =
      error.status === 401
        ? "unauthorized"
        : error.status === 403
          ? "forbidden"
          : error.status === 404
            ? "not_found"
            : "unavailable"
    return new RouteSlotLoadError(code)
  }
  const knownCodes = new Set([
    "unauthorized",
    "forbidden",
    "not_found",
    "malformed",
    "unknown_slot",
    "unknown_route",
    "invalid_target",
    "too_large",
    "unavailable",
  ])
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = Reflect.get(error, "code")
    if (typeof code === "string" && knownCodes.has(code)) return new RouteSlotLoadError(code)
  }
  if (error instanceof Response) {
    const code =
      error.status === 401
        ? "unauthorized"
        : error.status === 403
          ? "forbidden"
          : error.status === 404
            ? "not_found"
            : "unavailable"
    return new RouteSlotLoadError(code)
  }
  return new RouteSlotLoadError("unavailable")
}

/** Resolve an addressed slot through the current router and its normal authorized route-data path. */
export async function loadRouteSlot(
  runtime: RouteSlotRuntime,
  name: string,
  parentPath: string,
  targetValue: string,
  signal: AbortSignal,
): Promise<LoadedRouteSlot> {
  return withRouteSlotConcurrency(signal, async () => {
    const targetPath = normalizeRouteSlotTarget(targetValue)
    const parent = runtime.router.match(stripRouteSlots(parentPath))
    if (parent === null) throw new Error("[nifra/web] route-slot parent route is unavailable")
    const allowed = runtime.router.routeSlotsFor(parent.routeId)[name]
    if (allowed === undefined)
      throw new Error("[nifra/web] route-slot name is not registered on this route")
    const target = runtime.router.match(targetPath)
    if (target === null || !allowed.includes(runtime.router.routePattern(target.routeId) ?? ""))
      throw new Error("[nifra/web] route-slot target route is not registered")

    await runtime.router.loadModule(target.routeId, targetPath)
    if (signal.aborted) throw signal.reason
    const response = await fetchRouteData(targetPath, target, signal)
    const envelope = isRouteDataEnvelope(response) ? response : undefined
    if (envelope?.status !== undefined) {
      const code =
        envelope.status === 401
          ? "unauthorized"
          : envelope.status === 403
            ? "forbidden"
            : envelope.status === 404
              ? "not_found"
              : "unavailable"
      throw new RouteSlotLoadError(code)
    }
    const chain = runtime.routes[target.routeId]
    if (chain === undefined)
      throw new Error("[nifra/web] route-slot component chain is unavailable")
    const matchChain = runtime.matchChains?.[target.routeId]
    const common = {
      routeId: target.routeId,
      path: targetPath,
      parentPath: stripRouteSlots(parentPath),
      params: target.params,
      search: searchOfChain(
        runtime.searchSchemas?.[target.routeId] ?? [],
        new URL(targetPath, "https://nifra.invalid").search,
      ),
      ...(matchChain === undefined ? undefined : { matchChain }),
    }

    if (envelope === undefined) return { ...common, data: response, chain }
    return {
      ...common,
      data: envelope.data,
      ...(envelope.serverComponents === undefined
        ? undefined
        : { serverComponents: envelope.serverComponents }),
      ...(envelope.layoutData === undefined ? undefined : { layoutData: envelope.layoutData }),
      ...(envelope.boundaries === undefined ? undefined : { boundaries: envelope.boundaries }),
      ...(envelope.live === undefined ? undefined : { live: envelope.live }),
      chain,
    }
  }).catch((error: unknown) => {
    if (signal.aborted) throw error
    throw stableSlotError(error)
  })
}

export type RouteSlotMatch = RouteMatch
