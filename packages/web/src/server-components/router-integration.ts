import { PAGE_HIDE_EVENT, PAGE_SHOW_EVENT } from "../internal/page-events.ts"
import type { ClientRouter } from "../router.ts"
import type { ComponentController } from "./client.ts"
import { componentControllers } from "./registry.ts"

/**
 * Optional router integration; imported only by opted-in application entries. The components of a
 * `keepAlive` page are parked while it is hidden, so navigation leaves them as they are.
 */
export function bindComponentRouter(
  router: Pick<ClientRouter, "snapshot" | "subscribe">,
): () => void {
  let previous = router.snapshot()
  const onPage = (event: Event): void => {
    const page = event.target
    if (page instanceof Node)
      for (const controller of componentControllers)
        if (event.type === PAGE_HIDE_EVENT) controller.park(page)
        else controller.unpark(page)
  }
  const target = typeof document === "undefined" ? undefined : document
  target?.addEventListener(PAGE_HIDE_EVENT, onPage)
  target?.addEventListener(PAGE_SHOW_EVENT, onPage)
  const stop = router.subscribe(() => {
    const next = router.snapshot()
    if (next.pending && next.pendingPath !== previous.pendingPath)
      for (const controller of componentControllers) controller.cancelPending()
    if (
      !next.pending &&
      (next.serverComponents !== previous.serverComponents || next.path !== previous.path)
    ) {
      for (const controller of componentControllers) {
        const task =
          next.serverComponents === undefined
            ? controller.navigate()
            : controller.adopt(next.serverComponents, next.path)
        void task.catch(() => controller.reportError("component_failed"))
      }
    }
    previous = next
  })
  return () => {
    stop()
    target?.removeEventListener(PAGE_HIDE_EVENT, onPage)
    target?.removeEventListener(PAGE_SHOW_EVENT, onPage)
  }
}

/** Refresh only after the existing mutation transport reports success. */
export async function refreshAfterComponentMutation<T extends { readonly ok: boolean }>(
  mutation: Promise<T>,
  controller: ComponentController,
  instances: readonly string[],
): Promise<T> {
  const result = await mutation
  if (result.ok)
    await Promise.all([...new Set(instances)].map((instance) => controller.refresh(instance)))
  return result
}
