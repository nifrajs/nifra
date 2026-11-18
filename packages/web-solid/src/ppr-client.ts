import { type HoleRoot, holeHost } from "@nifrajs/web/internal/hole-runtime"
import { dynamic, hydrate, type JSX } from "@solidjs/web"
import {
  createComponent,
  createEffect,
  createStore,
  isHydrating,
  onSettled,
  reconcile,
  untrack,
} from "solid-js"

const HostDiv = dynamic(() => "div")

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null

/**
 * A hole's host in the browser: once mounted, the PPR runtime's fill goes in, an interactive hole
 * hydrates that server HTML as its own root from the frame's props, and each refill `fill` brings is
 * applied in place. Object props reach the root as a store, so a refill updates it and keeps its
 * state; any other value makes the root again.
 */
export function clientHost<Data>(
  name: string,
  render: (data: Data) => JSX.Element,
  interactive: boolean,
  attributes: Readonly<Record<string, string>>,
  fill: () => unknown,
): JSX.Element {
  let host: HTMLElement | undefined
  let driven: ReturnType<typeof holeHost> | undefined
  const element = createComponent(HostDiv, {
    ref: (el: HTMLElement) => {
      host = el
    },
    ...attributes,
  })
  onSettled(() => {
    const target = host
    if (target === undefined) return
    const root = (into: Element, data: unknown): HoleRoot => {
      const [props, setProps] = createStore({ value: data })
      let dispose: (() => void) | undefined
      let left = false
      const start = (): void => {
        if (left) return
        dispose = hydrate(
          // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the server framed these props from this hole's own loader, through its output guard.
          () => render(props.value as Data),
          into,
          { renderId: `nifra-${name}-` },
        )
      }
      // Solid keeps one hydration context: a fill met while the page hydrates waits for it to end.
      if (isHydrating()) queueMicrotask(start)
      else start()
      return {
        update: (next) => {
          if (!isObject(next) || !isObject(props.value)) return false
          setProps((draft) => {
            const current = draft.value
            if (isObject(current)) reconcile(next)(current)
          })
          return true
        },
        dispose: () => {
          left = true
          dispose?.()
        },
      }
    }
    const mounted = holeHost(name, target, interactive ? root : undefined)
    driven = mounted
    const first = untrack(fill)
    if (first !== undefined) mounted.refill(first)
    return () => mounted.dispose()
  })
  // Refills after the first: the mount above takes the fill that was there when the host settled.
  createEffect(
    fill,
    (next) => {
      if (next !== undefined) driven?.refill(next)
    },
    { defer: true },
  )
  return element
}
