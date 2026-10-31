import type { RouteSlotName } from "@nifrajs/web"
import type { Component, Snippet } from "svelte"

export interface RouteSlotProps {
  name: RouteSlotName
  /** Rendered while the addressed route is loading. */
  children?: Snippet
  /** Rendered when the authorized route request fails, with a stable error code. */
  error?: Snippet<[code: string]>
}

declare const RouteSlot: Component<RouteSlotProps>
export default RouteSlot
