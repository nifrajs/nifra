import type { RouteSlotName, RouteSlotTarget } from "@nifrajs/web"
import {
  getRouteSlotStore,
  type LoadedRouteSlot,
  type RouteSlotStatus,
  rawHref,
  routeSlotSyncKey,
  routeSlotTargetFromPath,
  setRouteSlot,
  stripRouteSlots,
  syncRouteSlotStore,
} from "@nifrajs/web/client"
import { createElement, type ReactNode, useContext, useEffect, useSyncExternalStore } from "react"
import { compose } from "./compose.ts"
import { RouterContext, useNavigate } from "./router.ts"

export interface RouteSlotController {
  readonly target: string | undefined
  readonly status: RouteSlotStatus
  readonly content: LoadedRouteSlot | undefined
  readonly error: string | undefined
  open(target: RouteSlotTarget): void
  close(): void
}

export interface RouteSlotProps {
  readonly name: RouteSlotName
  readonly fallback?: ReactNode
  readonly error?: ReactNode | ((code: string) => ReactNode)
}

/** Read or navigate one route slot without changing any sibling slot's URL state or component tree. */
export function useRouteSlot(name: RouteSlotName): RouteSlotController {
  const location = useContext(RouterContext)
  const navigate = useNavigate()
  const { target, error: parseError } = routeSlotTargetFromPath(location.path, name)
  const basePath = stripRouteSlots(location.path)
  const pending = location.pending === true
  const store = getRouteSlotStore(basePath, name)
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot)
  const requestKey = routeSlotSyncKey(basePath, name, target, parseError, pending)
  useEffect(() => {
    syncRouteSlotStore(store, basePath, name, target, parseError, pending)
  }, [basePath, name, parseError, pending, store, target])

  const current = snapshot.key === requestKey ? snapshot : undefined
  return {
    target,
    status:
      current?.status ??
      (parseError !== undefined ? "error" : pending || target === undefined ? "idle" : "loading"),
    content: current?.content,
    error: current?.error ?? parseError,
    open: (next) => navigate(rawHref(setRouteSlot(location.path, name, String(next)))),
    close: () => navigate(rawHref(setRouteSlot(location.path, name, null))),
  }
}

/** Render the registered route's complete layout and page chain in this independently navigable region. */
export function RouteSlot({ name, fallback = null, error }: RouteSlotProps): ReactNode {
  const slot = useRouteSlot(name)
  if (slot.content !== undefined) return compose(slot.content.chain, slot.content)
  if (slot.status === "error") {
    if (typeof error === "function") return error(slot.error ?? "unavailable")
    if (error !== undefined) return error
    return createElement(
      "div",
      { role: "alert", "data-route-slot-error": slot.error ?? "unavailable" },
      "This panel is unavailable.",
    )
  }
  return slot.target !== undefined ? fallback : null
}
