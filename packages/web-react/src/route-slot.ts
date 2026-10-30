import type { RouteSlotName, RouteSlotTarget } from "@nifrajs/web"
import {
  getRouteSlotRuntime,
  type LoadedRouteSlot,
  loadRouteSlot,
  onRouteSlotIdentityChange,
  parseRouteSlots,
  RouteSlotLoadError,
  RouteSlotStateError,
  rawHref,
  setRouteSlot,
  stripRouteSlots,
} from "@nifrajs/web/client"
import { createElement, type ReactNode, useContext, useEffect, useRef, useState } from "react"
import { compose } from "./compose.ts"
import { RouterContext, useNavigate } from "./router.ts"

export interface RouteSlotController {
  readonly target: string | undefined
  readonly status: "idle" | "loading" | "ready" | "error"
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

interface RouteSlotState {
  readonly key?: string
  readonly status: RouteSlotController["status"]
  readonly content?: LoadedRouteSlot
  readonly error?: string
}

/** Read or navigate one route slot without changing any sibling slot's URL state or component tree. */
export function useRouteSlot(name: RouteSlotName): RouteSlotController {
  const location = useContext(RouterContext)
  const navigate = useNavigate()
  const [focusEpoch, setFocusEpoch] = useState(0)
  const activeRequest = useRef<AbortController | undefined>(undefined)
  const requestEpoch = useRef(0)
  const [state, setState] = useState<RouteSlotState>({ status: "idle" })
  let target: string | undefined
  let parseError: string | undefined
  try {
    target = parseRouteSlots(location.path)[name]
  } catch (error) {
    parseError = error instanceof RouteSlotStateError ? error.code : "malformed"
  }
  const basePath = stripRouteSlots(location.path)
  const requestKey = `${basePath}\0${name}\0${target ?? ""}\0${focusEpoch}\0${location.pending ? 1 : 0}`

  useEffect(() => {
    const controller = new AbortController()
    const epoch = ++requestEpoch.current
    const key = requestKey
    activeRequest.current = controller
    const cleanup = (): void => {
      controller.abort()
      if (activeRequest.current === controller) activeRequest.current = undefined
    }
    if (location.pending) {
      setState({ key, status: "idle" })
      return cleanup
    }
    if (parseError !== undefined) {
      setState({ key, status: "error", error: parseError })
      return cleanup
    }
    if (target === undefined) {
      setState({ key, status: "idle" })
      return cleanup
    }
    const runtime = getRouteSlotRuntime()
    if (runtime === undefined) {
      setState({ key, status: "error", error: "unavailable" })
      return cleanup
    }
    setState({ key, status: "loading" })
    void loadRouteSlot(runtime, name, basePath, target, controller.signal)
      .then((content) => {
        if (!controller.signal.aborted && requestEpoch.current === epoch)
          setState({ key, status: "ready", content })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && requestEpoch.current === epoch)
          setState({
            key,
            status: "error",
            error: error instanceof RouteSlotLoadError ? error.code : "unavailable",
          })
      })
    return cleanup
  }, [basePath, location.pending, name, parseError, requestKey, target])

  useEffect(() => {
    const refresh = (): void => {
      requestEpoch.current++
      activeRequest.current?.abort()
      activeRequest.current = undefined
      setState({ status: "idle" })
      setFocusEpoch((epoch) => epoch + 1)
    }
    window.addEventListener("focus", refresh)
    const unsubscribe = onRouteSlotIdentityChange(refresh)
    return () => {
      window.removeEventListener("focus", refresh)
      unsubscribe()
    }
  }, [])

  const current = state.key === requestKey ? state : undefined
  return {
    target,
    status: current?.status ?? (target === undefined ? "idle" : "loading"),
    content: current?.content,
    error: current?.error,
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
