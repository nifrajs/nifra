/**
 * VIEW SPIKE — declarative DOM binder over the signals core. Server renders plain HTML (the
 * vanilla adapter); the client "resumes" by walking `data-bind-*` attributes — no VDOM, no
 * hydration re-render, no component re-execution. This is the Qwik-flavored angle the adapter
 * seam can't express: markup is the serialization format, signals attach to it in place.
 *
 *   <span data-bind-text="count">0</span>
 *   <button data-bind-on="click:inc">+1</button>
 *
 *   mount(root, { count }, { inc: () => count.set((n) => n + 1) })
 */
import { effect, type Signal } from "./signals.ts"

type Signals = Record<string, Signal<unknown>>
type Handlers = Record<string, (event: Event) => void>

export function mount(root: ParentNode, signals: Signals, handlers: Handlers): void {
  for (const el of root.querySelectorAll<HTMLElement>("[data-bind-text]")) {
    const key = el.getAttribute("data-bind-text") as string
    const s = signals[key]
    if (s !== undefined)
      effect(() => {
        el.textContent = String(s())
      })
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-bind-show]")) {
    const key = el.getAttribute("data-bind-show") as string
    const s = signals[key]
    if (s !== undefined)
      effect(() => {
        el.hidden = !s()
      })
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-bind-on]")) {
    const spec = el.getAttribute("data-bind-on") as string // "click:inc" or "input:setQuery"
    const sep = spec.indexOf(":")
    const handler = handlers[spec.slice(sep + 1)]
    if (handler !== undefined) el.addEventListener(spec.slice(0, sep), handler)
  }
}
