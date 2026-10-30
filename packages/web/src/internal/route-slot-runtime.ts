import type { StandardSchemaV1 } from "@nifrajs/core/server"
import type { BoundaryStates } from "../boundary.ts"
import { onIdentityChange } from "../identity.ts"
import type { MatchChain } from "../render-seam.ts"
import { normalizeRouteSlotTarget, stripRouteSlots } from "../route-slots.ts"
import {
  type ClientRouter,
  fetchRouteData,
  isRouteDataEnvelope,
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

export interface RouteSlotRuntime {
  readonly router: ClientRouter
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

let active = 0
const queue: Array<() => void> = []

export function setRouteSlotRuntime(runtime: RouteSlotRuntime): void {
  Reflect.set(globalThis, RUNTIME_KEY, runtime)
}

export function onRouteSlotIdentityChange(listener: () => void): () => void {
  return onIdentityChange(listener)
}

export function getRouteSlotRuntime(): RouteSlotRuntime | undefined {
  const value: unknown = Reflect.get(globalThis, RUNTIME_KEY)
  if (typeof value !== "object" || value === null) return undefined
  const router: unknown = Reflect.get(value, "router")
  const routes: unknown = Reflect.get(value, "routes")
  const searchSchemas: unknown = Reflect.get(value, "searchSchemas")
  const matchChains: unknown = Reflect.get(value, "matchChains")
  if (
    typeof router !== "object" ||
    router === null ||
    typeof routes !== "object" ||
    routes === null
  )
    return undefined
  if (
    (searchSchemas !== undefined &&
      (typeof searchSchemas !== "object" || searchSchemas === null)) ||
    typeof Reflect.get(router, "match") !== "function" ||
    typeof Reflect.get(router, "loadModule") !== "function" ||
    typeof Reflect.get(router, "routeSlotsFor") !== "function" ||
    typeof Reflect.get(router, "routePattern") !== "function"
  )
    return undefined
  if (matchChains !== undefined && (typeof matchChains !== "object" || matchChains === null))
    return undefined
  return {
    router: router as ClientRouter,
    routes: routes as Readonly<Record<string, readonly unknown[]>>,
    searchSchemas: searchSchemas as
      | Readonly<Record<string, readonly (StandardSchemaV1 | undefined)[]>>
      | undefined,
    matchChains: matchChains as Readonly<Record<string, MatchChain>> | undefined,
  }
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
    if (!isRouteDataEnvelope(response)) {
      const chain = runtime.routes[target.routeId]
      if (chain === undefined)
        throw new Error("[nifra/web] route-slot component chain is unavailable")
      return {
        routeId: target.routeId,
        path: targetPath,
        parentPath: stripRouteSlots(parentPath),
        params: target.params,
        search: searchOfChain(
          runtime.searchSchemas?.[target.routeId] ?? [],
          new URL(targetPath, "https://nifra.invalid").search,
        ),
        data: response,
        ...(runtime.matchChains?.[target.routeId] === undefined
          ? {}
          : { matchChain: runtime.matchChains?.[target.routeId] }),
        chain,
      }
    }
    if (response.status !== undefined) {
      const code =
        response.status === 401
          ? "unauthorized"
          : response.status === 403
            ? "forbidden"
            : response.status === 404
              ? "not_found"
              : "unavailable"
      throw new RouteSlotLoadError(code)
    }
    const components = runtime.routes[target.routeId]
    if (components === undefined)
      throw new Error("[nifra/web] route-slot component chain is unavailable")
    return {
      routeId: target.routeId,
      path: targetPath,
      parentPath: stripRouteSlots(parentPath),
      params: target.params,
      search: searchOfChain(
        runtime.searchSchemas?.[target.routeId] ?? [],
        new URL(targetPath, "https://nifra.invalid").search,
      ),
      data: response.data,
      ...(response.serverComponents === undefined
        ? {}
        : { serverComponents: response.serverComponents }),
      ...(response.layoutData === undefined ? {} : { layoutData: response.layoutData }),
      ...(response.boundaries === undefined ? {} : { boundaries: response.boundaries }),
      ...(response.live === undefined ? {} : { live: response.live }),
      ...(runtime.matchChains?.[target.routeId] === undefined
        ? {}
        : { matchChain: runtime.matchChains?.[target.routeId] }),
      chain: components,
    }
  }).catch((error: unknown) => {
    if (signal.aborted) throw error
    throw stableSlotError(error)
  })
}

export type RouteSlotMatch = RouteMatch
