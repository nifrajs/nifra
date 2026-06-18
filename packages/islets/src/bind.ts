/**
 * The declarative binding walker — attaches signal-driven behavior to SERVER-RENDERED markup.
 * No VDOM, no hydration re-render: the HTML the server sent (e.g. via `@nifrajs/web-vanilla`) is
 * already the initial state; bindings update it surgically when signals change.
 *
 * The attribute set is CLOSED and documented — six bindings, no expression language. Values are
 * signal/handler NAMES looked up in the island's scope, never evaluated code, so markup can't
 * inject behavior:
 *
 *   data-bind-text="count"                  textContent ← String(signal())
 *   data-bind-show="isOpen"                 hidden ← !signal()
 *   data-bind-class="active:isOpen,b:sigB"  classList.toggle per pair
 *   data-bind-attr="aria-expanded:isOpen"   setAttribute / removeAttribute (false/null remove)
 *   data-bind-value="query"                 two-way <input>/<select>/<textarea> (input event)
 *   data-bind-on="click:inc,submit:save"    addEventListener per pair
 */

import { effect, type Signal } from "./signals.ts"

export type IslandScope = {
  readonly signals: Readonly<Record<string, Signal<unknown>>>
  readonly handlers: Readonly<Record<string, (event: Event) => void>>
}

const warned = new Set<string>()
/** Unknown names warn once (loud in dev, resilient in prod — progressive enhancement must not
 * throw over a typo'd attribute) and the binding is skipped. */
function warnOnce(kind: string, name: string): void {
  const key = `${kind}:${name}`
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`[nifra/islets] unknown ${kind} ${JSON.stringify(name)} — binding skipped`)
}

function signalOf(scope: IslandScope, name: string): Signal<unknown> | undefined {
  const s = scope.signals[name]
  if (s === undefined) warnOnce("signal", name)
  return s
}

/** Parse a `"key:name,key2:name2"` pair list (whitespace-tolerant). Malformed entries skip. */
function pairs(spec: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const part of spec.split(",")) {
    const sep = part.indexOf(":")
    if (sep <= 0) continue
    const key = part.slice(0, sep).trim()
    const name = part.slice(sep + 1).trim()
    if (key.length > 0 && name.length > 0) out.push([key, name])
  }
  return out
}

/** The element surface the walker needs — structural, so tests can drive it without a real DOM. */
export interface BindableElement {
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  textContent: string | null
  hidden: boolean
  value?: string
  readonly classList: { toggle(name: string, force?: boolean): unknown }
  addEventListener(type: string, listener: (event: Event) => void): void
}

export interface BindableRoot {
  querySelectorAll(selector: string): Iterable<BindableElement>
}

/** Walk `root` and attach every `data-bind-*` binding against `scope`. Returns the disposers of
 * the created effects (an island unmount can stop them; page-lifetime islands just drop them). */
export function bindScope(root: BindableRoot, scope: IslandScope): Array<() => void> {
  const stops: Array<() => void> = []

  for (const el of root.querySelectorAll("[data-bind-text]")) {
    const s = signalOf(scope, el.getAttribute("data-bind-text") ?? "")
    if (s) {
      stops.push(
        effect(() => {
          el.textContent = String(s())
        }),
      )
    }
  }

  for (const el of root.querySelectorAll("[data-bind-show]")) {
    const s = signalOf(scope, el.getAttribute("data-bind-show") ?? "")
    if (s) {
      stops.push(
        effect(() => {
          el.hidden = !s()
        }),
      )
    }
  }

  for (const el of root.querySelectorAll("[data-bind-class]")) {
    for (const [className, name] of pairs(el.getAttribute("data-bind-class") ?? "")) {
      const s = signalOf(scope, name)
      if (s) {
        stops.push(
          effect(() => {
            el.classList.toggle(className, Boolean(s()))
          }),
        )
      }
    }
  }

  for (const el of root.querySelectorAll("[data-bind-attr]")) {
    for (const [attr, name] of pairs(el.getAttribute("data-bind-attr") ?? "")) {
      const s = signalOf(scope, name)
      if (s) {
        stops.push(
          effect(() => {
            const v = s()
            if (v === false || v === null || v === undefined) el.removeAttribute(attr)
            else el.setAttribute(attr, String(v))
          }),
        )
      }
    }
  }

  for (const el of root.querySelectorAll("[data-bind-value]")) {
    const s = signalOf(scope, el.getAttribute("data-bind-value") ?? "")
    if (s) {
      stops.push(
        effect(() => {
          const next = String(s())
          // Skip same-value writes: resetting an input's value mid-typing moves the caret.
          if (el.value !== next) el.value = next
        }),
      )
      el.addEventListener("input", () => s.set(el.value ?? ""))
    }
  }

  for (const el of root.querySelectorAll("[data-bind-on]")) {
    for (const [event, name] of pairs(el.getAttribute("data-bind-on") ?? "")) {
      const handler = scope.handlers[name]
      if (handler === undefined) {
        warnOnce("handler", name)
        continue
      }
      el.addEventListener(event, handler)
    }
  }

  return stops
}
