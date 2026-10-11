import type { ClientRouter } from "../router.ts"
import type { ComponentController } from "./client.ts"
import { componentControllers } from "./registry.ts"

/** Optional router integration; imported only by opted-in application entries. */
export function bindComponentRouter(
  router: Pick<ClientRouter, "snapshot" | "subscribe">,
): () => void {
  let previous = router.snapshot()
  return router.subscribe(() => {
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
