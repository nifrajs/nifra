/**
 * Whether a page is on screen, for a `keepAlive` page that stays mounted while it is hidden. Pages read
 * it through `@nifrajs/web-vue/router`; the keep-alive mount provides it per kept page. A kept page also
 * gets Vue's own `onActivated` / `onDeactivated`, since it runs under `<KeepAlive>`.
 */
import { computed, type InjectionKey, inject, onScopeDispose, type Ref } from "vue"

/** What one kept page provides: whether it is hidden, and the callbacks it runs as that changes. */
export interface PageSlot {
  readonly hidden: Ref<boolean>
  readonly hide: Set<() => void>
  readonly show: Set<() => void>
}

// `Symbol.for` for the same reason as the route context's keys (see route-context.ts).
// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: InjectionKey only brands a symbol's type, and every provide of this registry key passes a PageSlot.
export const PAGE_KEY: InjectionKey<PageSlot> = Symbol.for(
  "nifra.web-vue.page",
) as InjectionKey<PageSlot>

/**
 * Whether the page this component renders in is on screen, as a ref: `false` while it is kept hidden
 * behind another page, where it keeps running. Always `true` on the server and on a page that does not
 * keep alive.
 */
export function usePageVisibility(): Readonly<Ref<boolean>> {
  const slot = inject(PAGE_KEY, undefined)
  return computed(() => slot?.hidden.value !== true)
}

const onVisibility = (kind: "hide" | "show", callback: () => void): void => {
  const slot = inject(PAGE_KEY, undefined)
  if (slot === undefined) return
  slot[kind].add(callback)
  onScopeDispose(() => {
    slot[kind].delete(callback)
  })
}

/**
 * Run `callback` each time the `keepAlive` page this component renders in is hidden behind another
 * page, before it leaves the document (Vue's `onDeactivated` runs after). The page keeps running while
 * it is hidden: pause its timers, sockets and media here. Call it in `setup`; it is removed with the
 * component. A no-op outside a kept page.
 */
export function onPageHide(callback: () => void): void {
  onVisibility("hide", callback)
}

/**
 * Run `callback` each time the `keepAlive` page this component renders in is shown again, once it is
 * back in the document with its scroll and focus. Unlike Vue's `onActivated`, not when it first mounts.
 */
export function onPageShow(callback: () => void): void {
  onVisibility("show", callback)
}
