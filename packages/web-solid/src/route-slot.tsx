import type { RenderProps, RouteSlotName, RouteSlotTarget } from "@nifrajs/web"
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
import { navigateNow } from "@nifrajs/web/internal/navigate-runtime"
import { dynamic, type JSX } from "@solidjs/web"
import {
  createComponent,
  createEffect,
  createMemo,
  createSignal,
  untrack,
  useContext,
} from "solid-js"
import { compose } from "./compose.ts"
import { RenderPropsContext } from "./router-context.ts"

export interface RouteSlotController {
  readonly target: () => string | undefined
  readonly status: () => RouteSlotStatus
  readonly content: () => LoadedRouteSlot | undefined
  readonly error: () => string | undefined
  open(target: RouteSlotTarget): void
  close(): void
}

export interface RouteSlotHooks {
  /** `effect` may return its cleanup, which Solid runs before the next run and on disposal. */
  // biome-ignore lint/suspicious/noConfusingVoidType: this is Solid's own effect signature, which a handler with no cleanup satisfies by returning nothing.
  createEffect<T>(compute: () => T, effect: (value: T) => void | (() => void)): void
  createMemo<T>(read: () => T): () => T
  createSignal<T>(initial: T): readonly [() => T, (next: T | ((previous: T) => T)) => void]
}

export interface RouteSlotProps {
  readonly name: RouteSlotName
  readonly fallback?: JSX.Element
  readonly error?: JSX.Element | ((code: string) => JSX.Element)
}

/** Build the hook with its small reactive surface; the test seam avoids global module mocks. */
export function createRouteSlotBinding(
  readProps: () => RenderProps | undefined,
  navigate: (href: ReturnType<typeof rawHref>) => void,
  hooks: RouteSlotHooks,
): (name: RouteSlotName) => RouteSlotController {
  return function useRouteSlot(name: RouteSlotName): RouteSlotController {
    const props = readProps()
    const path = (): string => props?.path ?? "/"
    const pending = (): boolean => props?.pending === true
    const parsed = hooks.createMemo(() => routeSlotTargetFromPath(path(), name))
    const basePath = hooks.createMemo(() => stripRouteSlots(path()))
    const store = hooks.createMemo(() => getRouteSlotStore(basePath(), name))
    const [snapshot, setSnapshot] = hooks.createSignal<RouteSlotSnapshot>(
      store().getServerSnapshot(),
    )
    const requestKey = hooks.createMemo(() =>
      routeSlotSyncKey(basePath(), name, parsed().target, parsed().error, pending()),
    )

    hooks.createEffect(store, (currentStore) => {
      setSnapshot(currentStore.getSnapshot())
      return currentStore.subscribe(() => setSnapshot(currentStore.getSnapshot()))
    })

    hooks.createEffect(
      () => ({ current: parsed(), target: store(), base: basePath(), pending: pending() }),
      ({ current, target, base, pending }) => {
        syncRouteSlotStore(target, base, name, current.target, current.error, pending)
      },
    )

    const current = hooks.createMemo(() => {
      const value = snapshot()
      return value.key === requestKey() ? value : undefined
    })

    return {
      target: () => parsed().target,
      status: () =>
        current()?.status ??
        (parsed().error !== undefined
          ? "error"
          : pending() || parsed().target === undefined
            ? "idle"
            : "loading"),
      content: () => current()?.content,
      error: () => current()?.error ?? parsed().error,
      open: (target) => navigate(rawHref(setRouteSlot(path(), name, String(target)))),
      close: () => navigate(rawHref(setRouteSlot(path(), name, null))),
    }
  }
}

/** Read or navigate one route slot without changing any sibling slot's URL state or component tree. */
export const useRouteSlot = createRouteSlotBinding(
  () => useContext(RenderPropsContext) ?? undefined,
  navigateNow,
  { createEffect, createMemo, createSignal },
)

const AlertDiv = dynamic(() => "div")

/** Render the registered route's complete layout and page chain in this independently navigable region. */

export function RouteSlot(props: RouteSlotProps): JSX.Element {
  const slot = useRouteSlot(props.name)
  const view = createMemo(() => {
    const content = slot.content()
    if (content !== undefined) return untrack(() => compose(content.chain, content)())
    if (slot.status() === "error") {
      const code = slot.error() ?? "unavailable"
      const error = props.error
      if (typeof error === "function") return untrack(() => error(code))
      if (error !== undefined) return error
      return untrack(() =>
        createComponent(AlertDiv, {
          role: "alert",
          "data-route-slot-error": code,
          children: "This panel is unavailable.",
        }),
      )
    }
    return slot.target() !== undefined ? (props.fallback ?? null) : null
  })
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: Solid inserts an accessor reactively as its child, while its JSX.Element type excludes functions.
  return view as unknown as JSX.Element
}
