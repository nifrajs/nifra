import { expect, test } from "bun:test"
import { createApp, effectScope, ref } from "vue"
import {
  onPageHide,
  onPageShow,
  PAGE_KEY,
  type PageSlot,
  usePageVisibility,
} from "../src/page-visibility.ts"

// What a kept page's slot provides, read in process; the browser suite hides and shows kept pages.
const within = (slot: PageSlot | undefined, run: () => void): (() => void) => {
  const app = createApp({})
  if (slot !== undefined) app.provide(PAGE_KEY, slot)
  const scope = effectScope()
  scope.run(() => app.runWithContext(run))
  return () => scope.stop()
}

test("a kept page reads its slot's visibility, and its callbacks leave with its scope", () => {
  const slot: PageSlot = { hidden: ref(true), hide: new Set(), show: new Set() }
  const seen: boolean[] = []
  const stop = within(slot, () => {
    const visible = usePageVisibility()
    seen.push(visible.value)
    slot.hidden.value = false
    seen.push(visible.value)
    onPageHide(() => {})
    onPageShow(() => {})
  })
  expect(seen).toEqual([false, true])
  expect([slot.hide.size, slot.show.size]).toEqual([1, 1])
  stop()
  expect([slot.hide.size, slot.show.size]).toEqual([0, 0])
})

test("outside a kept page it is always visible, and the callbacks register nothing", () => {
  let visible: boolean | undefined
  within(undefined, () => {
    visible = usePageVisibility().value
    onPageHide(() => {})
    onPageShow(() => {})
  })()
  expect(visible).toBe(true)
})
