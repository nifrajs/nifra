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
import {
  type ComputedRef,
  computed,
  defineComponent,
  h,
  inject,
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
  readonly status: ComputedRef<RouteSlotStatus>
  readonly content: ComputedRef<LoadedRouteSlot | undefined>
  readonly error: ComputedRef<string | undefined>
  open(target: RouteSlotTarget): void
  close(): void
}

/** Read or navigate one route slot without changing any sibling slot's URL state or component tree. */
export function useRouteSlot(name: RouteSlotName): RouteSlotController {
  const props = inject(PROPS_KEY, undefined)
  const navigate = useNavigate()
  const path = computed(() => props?.value.path ?? "/")
  const pending = computed(() => props?.value.pending === true)
  const parsed = computed(() => routeSlotTargetFromPath(path.value, name))
  const basePath = computed(() => stripRouteSlots(path.value))
  const store = computed(() => getRouteSlotStore(basePath.value, name))
  const snapshot: ShallowRef<RouteSlotSnapshot> = shallowRef(store.value.getServerSnapshot())

  watchEffect((onCleanup) => {
    const currentStore = store.value
    if (typeof window === "undefined") {
      snapshot.value = currentStore.getServerSnapshot()
      return
    }
    snapshot.value = currentStore.getSnapshot()
    const unsubscribe = currentStore.subscribe(() => {
      snapshot.value = currentStore.getSnapshot()
    })
    onCleanup(unsubscribe)
  })

  watchEffect(() => {
    if (typeof window === "undefined") return
    const current = parsed.value
    syncRouteSlotStore(
      store.value,
      basePath.value,
      name,
      current.target,
      current.error,
      pending.value,
    )
  })

  const requestKey = computed(() =>
    routeSlotSyncKey(basePath.value, name, parsed.value.target, parsed.value.error, pending.value),
  )
  const current = computed(() =>
    snapshot.value.key === requestKey.value ? snapshot.value : undefined,
  )
  return {
    target: computed(() => parsed.value.target),
    status: computed(
      () =>
        current.value?.status ??
        (parsed.value.error !== undefined
          ? "error"
          : pending.value || parsed.value.target === undefined
            ? "idle"
            : "loading"),
    ),
    content: computed(() => current.value?.content),
    error: computed(() => current.value?.error ?? parsed.value.error),
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
