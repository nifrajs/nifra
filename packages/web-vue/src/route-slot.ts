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
import {
  type ComputedRef,
  computed,
  defineComponent,
  h,
  inject,
  onScopeDispose,
  type PropType,
  type ShallowRef,
  shallowRef,
  watchEffect,
} from "vue"
import { compose } from "./compose.ts"
import { PROPS_KEY } from "./route-context.ts"
import { useNavigate } from "./router.ts"

export interface RouteSlotController {
  readonly target: ComputedRef<string | undefined>
  readonly status: ComputedRef<"idle" | "loading" | "ready" | "error">
  readonly content: ComputedRef<LoadedRouteSlot | undefined>
  readonly error: ComputedRef<string | undefined>
  open(target: RouteSlotTarget): void
  close(): void
}

type SlotState = {
  key?: string
  status: "idle" | "loading" | "ready" | "error"
  content?: LoadedRouteSlot
  error?: string
}

/** Read or navigate one route slot without changing any sibling slot's URL state or component tree. */
export function useRouteSlot(name: RouteSlotName): RouteSlotController {
  const props = inject(PROPS_KEY, undefined)
  const navigate = useNavigate()
  const path = computed(() => props?.value.path ?? "/")
  const pending = computed(() => props?.value.pending === true)
  const parsed = computed(() => {
    try {
      return { target: parseRouteSlots(path.value)[name], error: undefined }
    } catch (error) {
      return {
        target: undefined,
        error: error instanceof RouteSlotStateError ? error.code : "malformed",
      }
    }
  })
  const state: ShallowRef<SlotState> = shallowRef({ status: "idle" })
  const identityEpoch = shallowRef(0)
  let activeController: AbortController | undefined
  let requestEpoch = 0
  let unsubscribe = (): void => {}
  const refresh = (): void => {
    requestEpoch++
    activeController?.abort()
    activeController = undefined
    state.value = { status: "idle" }
    identityEpoch.value++
  }
  if (typeof window !== "undefined") {
    unsubscribe = onRouteSlotIdentityChange(refresh)
    window.addEventListener("focus", refresh)
  }
  onScopeDispose(() => {
    unsubscribe()
    if (typeof window !== "undefined") window.removeEventListener("focus", refresh)
  })

  watchEffect((onCleanup) => {
    const currentPath = path.value
    const isPending = pending.value
    const current = parsed.value
    const key = `${stripRouteSlots(currentPath)}\0${name}\0${current.target ?? ""}\0${identityEpoch.value}\0${isPending ? 1 : 0}`
    const epoch = ++requestEpoch
    const controller = new AbortController()
    activeController = controller
    onCleanup(() => {
      controller.abort()
      if (activeController === controller) activeController = undefined
    })
    // `watchEffect` also runs during SSR; slot content is intentionally client-loaded so it never
    // executes a second route loader as part of the page's cached/server render.
    if (typeof window === "undefined" || isPending) {
      state.value = { key, status: "idle" }
      return
    }
    if (current.error !== undefined) {
      state.value = { key, status: "error", error: current.error }
      return
    }
    if (current.target === undefined) {
      state.value = { key, status: "idle" }
      return
    }
    const runtime = getRouteSlotRuntime()
    if (runtime === undefined) {
      state.value = { key, status: "error", error: "unavailable" }
      return
    }
    state.value = { key, status: "loading" }
    void loadRouteSlot(
      runtime,
      name,
      stripRouteSlots(currentPath),
      current.target,
      controller.signal,
    )
      .then((content) => {
        if (!controller.signal.aborted && requestEpoch === epoch)
          state.value = { key, status: "ready", content }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && requestEpoch === epoch)
          state.value = {
            key,
            status: "error",
            error: error instanceof RouteSlotLoadError ? error.code : "unavailable",
          }
      })
  })

  const current = computed(() => {
    const key = `${stripRouteSlots(path.value)}\0${name}\0${parsed.value.target ?? ""}\0${identityEpoch.value}\0${pending.value ? 1 : 0}`
    return state.value.key === key ? state.value : undefined
  })
  return {
    target: computed(() => parsed.value.target),
    status: computed(
      () => current.value?.status ?? (parsed.value.target === undefined ? "idle" : "loading"),
    ),
    content: computed(() => current.value?.content),
    error: computed(() => current.value?.error),
    open: (target) => navigate(rawHref(setRouteSlot(path.value, name, String(target)))),
    close: () => navigate(rawHref(setRouteSlot(path.value, name, null))),
  }
}

export const RouteSlot = defineComponent({
  name: "NifraRouteSlot",
  props: {
    name: {
      // biome-ignore lint/plugin/noChainedTypeAssertions: Vue's String runtime constructor cannot encode the generated route-specific literal union; the runtime registry rejects names absent from the active route.
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Vue checks the prop as a string and the active route's registry validates the exact slot name before loading.
      type: String as unknown as PropType<RouteSlotName>,
      required: true,
    },
  },
  setup(props, { slots }) {
    // The runtime string prop is narrowed by generated RouteTable types in an application build.
    // Vue's String constructor cannot express that literal union in the adapter package build.
    const slot = useRouteSlot(props.name)
    return () => {
      const content = slot.content.value
      if (content !== undefined) return compose(content.chain, content)
      if (slot.status.value === "error") {
        const code = slot.error.value ?? "unavailable"
        const customError = slots.error?.({ code })
        return (
          customError ??
          h("div", { role: "alert", "data-route-slot-error": code }, "This panel is unavailable.")
        )
      }
      return slot.target.value === undefined ? null : (slots.fallback?.() ?? null)
    }
  },
})
