import type { Deferred } from "@nifrajs/web"
import type { Component, Snippet } from "svelte"

/**
 * Hand-written types for `Await.svelte` (svelte-package would generate this from the component). The
 * internal build resolves `*.svelte` via the ambient `svelte-shim.d.ts`; this file is what *consumers*
 * resolve through the `./await` export's `types` condition.
 */
export interface AwaitProps {
  /** A `Deferred<T>` from a loader/action's `defer(...)`, or an already-resolved value. */
  resolve: Deferred<unknown> | unknown
  /** Rendered with the resolved value (the default snippet). */
  children?: Snippet<[unknown]>
  /** Rendered while the deferred is pending (the SSR + pre-resolve state). */
  pending?: Snippet
  /** Rendered if the deferred rejects. */
  error?: Snippet<[unknown]>
}

declare const Await: Component<AwaitProps>
export default Await
