/**
 * The declarative binding walker - attaches signal-driven behavior to SERVER-RENDERED markup.
 * No VDOM, no hydration re-render: the HTML the server sent (e.g. via `@nifrajs/web-vanilla`) is
 * already the initial state; bindings update it surgically when signals change. `bindIsland` runs it.
 *
 * The attribute set is CLOSED and documented - six bindings, no expression language. Values are
 * signal/handler NAMES looked up in the island's scope, never evaluated code, so markup can't
 * inject behavior:
 *
 *   data-bind-text="count"                  textContent ← String(signal())
 *   data-bind-show="isOpen"                 hidden ← !signal()
 *   data-bind-class="active:isOpen,b:sigB"  classList.toggle per pair
 *   data-bind-attr="aria-expanded:isOpen"   setAttribute / removeAttribute (false/null remove);
 *                                           never an `on*` handler or `srcdoc`, and a URL attribute
 *                                           takes only an http(s)/mailto/tel or relative URL
 *   data-bind-value="query"                 two-way <input>/<select>/<textarea> (input and change)
 *   data-bind-on="click:inc,submit:save"    addEventListener per pair
 *
 * Nothing inside a `data-island-ignore` element binds or mounts: render user HTML there, so its
 * markup cannot reach the island's handlers or signals.
 *
 * A binding belongs to its nearest island: an island never binds inside a nested island's host. The
 * nested host element itself is still the outer island's markup, so the outer island may bind it.
 */

import { type Signal, watch } from "./island-signals.ts"

export type IslandScope = {
  readonly signals: Readonly<Record<string, Signal<unknown>>>
  readonly handlers: Readonly<Record<string, (event: Event) => void>>
}

const warned = new Set<string>()
/** Unknown names warn once (loud in dev, resilient in prod - progressive enhancement must not
 * throw over a typo'd attribute) and the binding is skipped. */
function warnOnce(kind: string, name: string): void {
  const key = `${kind}:${name}`
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`[nifra/islands] unknown ${kind} ${JSON.stringify(name)} - binding skipped`)
}

// Own keys only: a name such as `constructor` must not resolve to what a plain object inherits.
function named<V>(kind: string, record: Readonly<Record<string, V>>, name: string): V | undefined {
  if (Object.hasOwn(record, name)) return record[name]
  warnOnce(kind, name)
  return undefined
}

/** Parse a `"key:name,key2:name2"` pair list (whitespace-tolerant). Malformed entries skip. */
function pairs(spec: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const part of spec.split(",")) {
    const sep = part.indexOf(":")
    if (sep <= 0) continue
    const key = part.slice(0, sep).trim()
    const name = part.slice(sep + 1).trim()
    if (key && name) out.push([key, name])
  }
  return out
}

// A bound value is data (often from island state the markup carries), so an attribute that would run
// it as code, or navigate to it as a script URL, is refused.
const CODE_ATTRIBUTE = /^(?:on|srcdoc$)/i
const URL_ATTRIBUTE =
  /^(?:href|src|action|formaction|xlink:href|poster|data|background|cite|ping)$/i
const SAFE_URL = /^(?:(?:https?|mailto|tel):|[^:/?#]*(?:[/?#]|$))/i

/** The element surface the walker needs - structural, so tests can drive it without a real DOM. */
export interface BindableElement {
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  textContent: string | null
  hidden: boolean
  value?: string
  readonly classList: { toggle(name: string, force?: boolean): unknown }
  addEventListener(type: string, listener: (event: Event) => void): void
  removeEventListener(type: string, listener: (event: Event) => void): void
}

export interface BindableRoot {
  querySelectorAll(selector: string): Iterable<BindableElement>
}

/** Walk `root` and attach every `data-bind-*` binding against `scope`. Returns disposers for
 * both reactive effects and event listeners. */
export function bindScope(root: BindableRoot, scope: IslandScope): Array<() => void> {
  const stops: Array<() => void> = []
  // Each element carrying `data-bind-<kind>` outside any ignored subtree and any nested island, with
  // that attribute's value.
  const each = (kind: string): Array<[BindableElement, string]> => {
    const attribute = `data-bind-${kind}`
    return [
      ...root.querySelectorAll(
        `[${attribute}]:not([data-island-ignore],[data-island-ignore] *,:scope [data-island] *)`,
      ),
    ].map((el) => [el, el.getAttribute(attribute) ?? ""])
  }

  for (const [el, name] of each("text")) {
    const s = named("signal", scope.signals, name)
    if (s) {
      stops.push(
        watch(s, (v) => {
          el.textContent = String(v)
        }),
      )
    }
  }

  for (const [el, name] of each("show")) {
    const s = named("signal", scope.signals, name)
    if (s) {
      stops.push(
        watch(s, (v) => {
          el.hidden = !v
        }),
      )
    }
  }

  for (const [el, spec] of each("class")) {
    for (const [className, name] of pairs(spec)) {
      const s = named("signal", scope.signals, name)
      if (s) {
        stops.push(
          watch(s, (v) => {
            el.classList.toggle(className, !!v)
          }),
        )
      }
    }
  }

  for (const [el, spec] of each("attr")) {
    for (const [attr, name] of pairs(spec)) {
      if (CODE_ATTRIBUTE.test(attr)) {
        warnOnce("attribute", attr)
        continue
      }
      const s = named("signal", scope.signals, name)
      if (s) {
        const isUrl = URL_ATTRIBUTE.test(attr)
        stops.push(
          watch(s, (v) => {
            if (v === false || v == null || (isUrl && !SAFE_URL.test(String(v).trim())))
              el.removeAttribute(attr)
            else el.setAttribute(attr, String(v))
          }),
        )
      }
    }
  }

  for (const [el, name] of each("value")) {
    const s = named("signal", scope.signals, name)
    if (s) {
      stops.push(
        watch(s, (v) => {
          const next = String(v)
          // Skip same-value writes: resetting an input's value mid-typing moves the caret.
          if (el.value !== next) el.value = next
        }),
      )
      const input = (): void => s.set(el.value ?? "")
      // A <select> commits on `change`, and browsers disagree on whether `input` comes first. The
      // second event of a pair writes the same value, which the signal skips.
      for (const type of ["input", "change"]) {
        el.addEventListener(type, input)
        stops.push(() => el.removeEventListener(type, input))
      }
    }
  }

  for (const [el, spec] of each("on")) {
    for (const [event, name] of pairs(spec)) {
      const handler = named("handler", scope.handlers, name)
      if (handler === undefined) continue
      el.addEventListener(event, handler)
      stops.push(() => el.removeEventListener(event, handler))
    }
  }

  return stops
}
