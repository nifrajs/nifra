import type { ComponentController } from "./client.ts"

export const componentControllers = new Set<ComponentController>()
let channel: BroadcastChannel | undefined
function connectInvalidation(): void {
  if (
    typeof window === "undefined" ||
    typeof BroadcastChannel === "undefined" ||
    channel !== undefined
  )
    return
  channel = new BroadcastChannel("nifra-component-scope-v1")
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if (event.data === 1)
      for (const controller of componentControllers)
        void controller.invalidateScope().catch(() => controller.reportError("component_failed"))
  }
}
export async function invalidateComponentScope(): Promise<void> {
  await Promise.all([...componentControllers].map((controller) => controller.invalidateScope()))
  channel?.postMessage(1)
}

export function registerComponentController(controller: ComponentController): void {
  componentControllers.add(controller)
  connectInvalidation()
}
export function unregisterComponentController(controller: ComponentController): void {
  componentControllers.delete(controller)
  if (componentControllers.size === 0) {
    channel?.close()
    channel = undefined
  }
}
