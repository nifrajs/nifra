import type { RenderProps, RouteSlotName, RouteSlotTarget } from "@nifrajs/web"
import { parseRouteSlots, rawHref, setRouteSlot } from "@nifrajs/web/client"
import { getContext } from "svelte"
import { useNavigate } from "./router.ts"

export interface RouteSlotController {
  readonly target: string | undefined
  open(target: RouteSlotTarget): void
  close(): void
}

/** Read or update the URL state for one slot while preserving every sibling slot. */
export function createRouteSlotController(
  name: RouteSlotName,
  path: () => string,
  navigate: (href: ReturnType<typeof rawHref>) => void,
): RouteSlotController {
  return {
    get target() {
      try {
        return parseRouteSlots(path())[name]
      } catch {
        return undefined
      }
    },
    open: (target) => navigate(rawHref(setRouteSlot(path(), name, String(target)))),
    close: () => navigate(rawHref(setRouteSlot(path(), name, null))),
  }
}

export function useRouteSlot(name: RouteSlotName): RouteSlotController {
  const readProps = getContext<(() => RenderProps) | undefined>("@nifrajs/web-svelte:props")
  const navigate = useNavigate()
  return createRouteSlotController(name, () => readProps?.().path ?? "/", navigate)
}
