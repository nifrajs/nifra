import { createComponent, type JSX, onCleanup, onMount, sharedConfig } from "solid-js"
import { Dynamic, hydrate } from "solid-js/web"

/** One hole's fill, as the PPR runtime keeps it. */
interface HoleFill {
  readonly props?: unknown
  readonly error: boolean
}

interface PprRuntime {
  get(name: string): HoleFill | undefined
  subscribe(name: string, callback: (fill: HoleFill) => void): () => void
}

/** The runtime the shell's inline script defines, when this document has one. */
const pprRuntime = (): PprRuntime | undefined => {
  const runtime: unknown = Reflect.get(globalThis, "__nifraPpr")
  return typeof runtime === "function" && "get" in runtime && "subscribe" in runtime
    ? // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the shell's constant inline runtime defines exactly this shape (internal/ppr/runtime.ts in @nifrajs/web).
      (runtime as PprRuntime)
    : undefined
}

/**
 * An interactive hole's host in the browser: once mounted, it hydrates the server's HTML the PPR
 * runtime put into it as its own root, from the frame's props, and disposes that root on leave.
 */
export function interactiveHost<Data>(
  name: string,
  render: (data: Data) => JSX.Element,
  attributes: Readonly<Record<string, string>>,
): JSX.Element {
  let host: HTMLElement | undefined
  const element = createComponent(Dynamic, {
    component: "div",
    ref: (el: HTMLElement) => {
      host = el
    },
    ...attributes,
  })
  onMount(() => {
    const runtime = pprRuntime()
    const target = host
    if (target === undefined || runtime === undefined) return
    let dispose: (() => void) | undefined
    let left = false
    const start = (frame: HoleFill): void => {
      if (left || dispose !== undefined) return
      dispose = hydrate(
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the server framed these props from this hole's own loader, through its output guard.
        () => render(frame.props as Data),
        target,
        { renderId: `nifra-${name}-` },
      )
    }
    const fill = (frame: HoleFill): void => {
      if (frame.error) return
      // Solid keeps one hydration context: a fill met while the page hydrates waits for it to end.
      if (sharedConfig.context) queueMicrotask(() => start(frame))
      else start(frame)
    }
    const now = runtime.get(name)
    const unsubscribe = now === undefined ? runtime.subscribe(name, fill) : undefined
    if (now !== undefined) fill(now)
    onCleanup(() => {
      left = true
      unsubscribe?.()
      dispose?.()
    })
  })
  return element
}
