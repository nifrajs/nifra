import type { Component, Snippet } from "svelte"
import type { SvelteUI } from "./ppr.ts"

/** The fields of a route's boundary declaration a hole renders from. */
export interface HoleDefinition<Data> {
  readonly name: string
  readonly render: (data: Data) => SvelteUI
  readonly fallback?: SvelteUI
  readonly interactive?: boolean
}

/** The slice of a boundary state a hole reads: `ppr` marks a hole the shared shell left open. */
export interface HoleState {
  readonly status: "unresolved" | "pending" | "ready" | "error"
  readonly data?: unknown
  readonly ppr?: true
}

/** Hand-written types for `Hole.svelte`, as for `Await.svelte`. */
export interface HoleProps<Data> {
  of: HoleDefinition<Data>
  state: HoleState | undefined
  /** Shown when the hole's loader failed. Default: nothing. */
  error?: Snippet
}

declare const Hole: Component<HoleProps<never>>
export default Hole
