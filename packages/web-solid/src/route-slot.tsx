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
import { createEffect, createMemo, createSignal, type JSX, onCleanup, useContext } from "solid-js"
import { compose } from "./compose.ts"
import { RenderPropsContext, useNavigate } from "./router.ts"

export interface RouteSlotController {
  readonly target: () => string | undefined
  readonly status: () => RouteSlotStatus
  readonly content: () => LoadedRouteSlot | undefined
  readonly error: () => string | undefined
  open(target: RouteSlotTarget): void
  close(): void
}

type RouteSlotStatus = "idle" | "loading" | "ready" | "error"

interface RouteSlotState {
  readonly key?: string
  readonly status: RouteSlotStatus
  readonly content?: LoadedRouteSlot
  readonly error?: string
}

export interface RouteSlotProps {
  readonly name: RouteSlotName
  readonly fallback?: JSX.Element
  readonly error?: JSX.Element | ((code: string) => JSX.Element)
}

/** Read or navigate one route slot without changing any sibling slot's URL state or component tree. */
export function useRouteSlot(name: RouteSlotName): RouteSlotController {
  const props = useContext(RenderPropsContext)
  const navigate = useNavigate()
  const [focusEpoch, setFocusEpoch] = createSignal(0)
  const [state, setState] = createSignal<RouteSlotState>({ status: "idle" })
  const path = (): string => props?.path ?? "/"
  const parsed = createMemo(() => {
    try {
      return { target: parseRouteSlots(path())[name], error: undefined }
    } catch (error) {
      return {
        target: undefined,
        error: error instanceof RouteSlotStateError ? error.code : "malformed",
      }
    }
  })
  const requestKey = createMemo(
    () =>
      `${stripRouteSlots(path())}\0${name}\0${parsed().target ?? ""}\0${focusEpoch()}\0${props?.pending === true ? 1 : 0}`,
  )
  let activeController: AbortController | undefined
  let requestEpoch = 0

  createEffect(() => {
    const currentPath = path()
    const pending = props?.pending === true
    const current = parsed()
    focusEpoch()
    const key = requestKey()
    const epoch = ++requestEpoch
    const controller = new AbortController()
    activeController = controller
    const cleanup = (): void => {
      controller.abort()
      if (activeController === controller) activeController = undefined
    }
    onCleanup(cleanup)
    if (pending) {
      setState({ key, status: "idle" })
      return
    }
    if (current.error !== undefined) {
      setState({ key, status: "error", error: current.error })
      return
    }
    if (current.target === undefined) {
      setState({ key, status: "idle" })
      return
    }
    const runtime = getRouteSlotRuntime()
    if (runtime === undefined) {
      setState({ key, status: "error", error: "unavailable" })
      return
    }
    setState({ key, status: "loading" })
    void loadRouteSlot(
      runtime,
      name,
      stripRouteSlots(currentPath),
      current.target,
      controller.signal,
    )
      .then((content) => {
        if (!controller.signal.aborted && requestEpoch === epoch)
          setState({ key, status: "ready", content })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && requestEpoch === epoch)
          setState({
            key,
            status: "error",
            error: error instanceof RouteSlotLoadError ? error.code : "unavailable",
          })
      })
  })

  createEffect(() => {
    const refresh = (): void => {
      requestEpoch++
      activeController?.abort()
      activeController = undefined
      setState({ status: "idle" })
      setFocusEpoch((epoch) => epoch + 1)
    }
    const unsubscribe = onRouteSlotIdentityChange(refresh)
    if (typeof window !== "undefined") window.addEventListener("focus", refresh)
    onCleanup(() => {
      if (typeof window !== "undefined") window.removeEventListener("focus", refresh)
      unsubscribe()
    })
  })

  const current = (): RouteSlotState | undefined =>
    state().key === requestKey() ? state() : undefined
  return {
    target: () => parsed().target,
    status: () => current()?.status ?? (parsed().target === undefined ? "idle" : "loading"),
    content: () => current()?.content,
    error: () => current()?.error,
    open: (target) => navigate(rawHref(setRouteSlot(path(), name, String(target)))),
    close: () => navigate(rawHref(setRouteSlot(path(), name, null))),
  }
}

/** Render the registered route's complete layout and page chain in this independently navigable region. */
export function RouteSlot(props: RouteSlotProps): JSX.Element {
  const slot = useRouteSlot(props.name)
  const Render = (): JSX.Element => {
    const content = slot.content()
    if (content !== undefined) return compose(content.chain, content)()
    if (slot.status() === "error") {
      const code = slot.error() ?? "unavailable"
      if (typeof props.error === "function") return props.error(code)
      if (props.error !== undefined) return props.error
      return (
        <div role="alert" data-route-slot-error={code}>
          This panel is unavailable.
        </div>
      )
    }
    return slot.target() !== undefined ? (props.fallback ?? null) : null
  }
  return <Render />
}
