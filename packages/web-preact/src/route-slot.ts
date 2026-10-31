import type { RouteSlotName, RouteSlotTarget } from "@nifrajs/web"
import {
  getRouteSlotStore,
  type LoadedRouteSlot,
  type RouteSlotSnapshot,
  type RouteSlotStatus,
  rawHref,
  routeSlotSyncKey,
  routeSlotTargetFromPath,
  setRouteSlot,
  stripRouteSlots,
  syncRouteSlotStore,
} from "@nifrajs/web/client"
import { type ComponentChildren, Fragment, h, type VNode } from "preact"
import { useContext, useEffect, useState } from "preact/hooks"
import { compose } from "./compose.ts"
import { RenderPropsContext, useNavigate } from "./router.ts"

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
  readonly fallback?: ComponentChildren
  readonly error?: ComponentChildren | ((code: string) => ComponentChildren)
}

export function useRouteSlot(name: RouteSlotName): RouteSlotController {
  const props = useContext(RenderPropsContext)
  const navigate = useNavigate()
  const path = props?.path ?? "/"
  const pending = props?.pending === true
  const { target, error: parseError } = routeSlotTargetFromPath(path, name)
  const basePath = stripRouteSlots(path)
  const store = getRouteSlotStore(basePath, name)
  const [snapshot, setSnapshot] = useState<RouteSlotSnapshot>(() => store.getSnapshot())
  const requestKey = routeSlotSyncKey(basePath, name, target, parseError, pending)
  useEffect(() => {
    setSnapshot(store.getSnapshot())
    return store.subscribe(() => setSnapshot(store.getSnapshot()))
  }, [store])
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
    open: (next) => navigate(rawHref(setRouteSlot(path, name, String(next)))),
    close: () => navigate(rawHref(setRouteSlot(path, name, null))),
  }
}

export function RouteSlot({ name, fallback = null, error }: RouteSlotProps): VNode | null {
  const slot = useRouteSlot(name)
  if (slot.content !== undefined) return compose(slot.content.chain, slot.content)
  if (slot.status === "error") {
    if (typeof error === "function") return h(Fragment, null, error(slot.error ?? "unavailable"))
    if (error !== undefined) return h(Fragment, null, error)
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Preact's invariant VNode props need the same boundary widening used by compose.
    return h(
      "div",
      { role: "alert", "data-route-slot-error": slot.error ?? "unavailable" },
      "This panel is unavailable.",
    ) as VNode
  }
  return slot.target === undefined ? null : h(Fragment, null, fallback)
}
