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
 *                                           accepts explicit http(s)/mailto/tel and relative URLs;
 *                                           active elements and SVG animation bindings are refused
 *   data-bind-value="query"                 two-way <input>/<select>/<textarea> (input and change)
 *   data-bind-on="click:inc,submit:save"    addEventListener per pair
 *
 * Nothing inside a `data-island-ignore` element binds or mounts: render user HTML there, so its
 * markup cannot reach the island's handlers or signals.
 *
 * A binding belongs to its nearest island: an island never binds inside a nested island's host. The
 * nested host element itself is still the outer island's markup, so the outer island may bind it.
 */

import { type Signal, untrack, watch } from "./island-signals.ts"

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

/** Development only: a binding whose first value differs from the server-rendered markup changes the
 * page on mount. Reached only behind a `process.env.NODE_ENV` test, so a production build drops it. */
function warnDrift(binding: string, name: string, server: string, state: string): void {
  const key = `drift:${binding}:${name}`
  if (warned.has(key)) return
  warned.add(key)
  // Server text can be a whole article: show only its start.
  const clip = (text: string): string =>
    JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}...` : text)
  console.warn(
    `[nifra/islands] ${binding}="${name}": the server rendered ${clip(server)} but the island starts with ${clip(state)}, so the page changes on mount - render the same value on the server`,
  )
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
export const CODE_ATTRIBUTE = /^(?:on|srcdoc$)/i
export const URL_ATTRIBUTE =
  /^(?:href|src|action|formaction|xlink:href|poster|data|background|cite|ping)$/i
// HTTP(S) URL parsers strip leading controls and read backslashes as slashes.
const SAFE_URL =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject browser-normalized network paths
  /^(?![\x00-\x1f]|[\\/][\t\r\n]*[\\/])(?:(?:https?|mailto|tel):|[^:/?#]*(?:[/?#]|$))/i
// Elements whose URL attribute loads code or restyles and rebases the page: a bound value never
// reaches them, whatever its scheme.
export const URL_BLOCKED_TAG = /^(?:script|iframe|object|embed|link|base)$/i
// An SVG animation sets an attribute of its parent from its own attributes: a bound `to` or `values`
// can animate a link's `href` to a script URL, which the link then follows. No attribute of one binds.
export const SMIL_TAG = /^(?:set|animate|animatemotion|animatetransform)$/i

/** The element surface the walker needs - structural, so tests can drive it without a real DOM. */
export interface BindableElement {
  readonly localName?: string
  readonly tagName?: string
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

/** Walk `root` and attach every `data-bind-*` binding against `scope`. Each binding's disposer
 * (reactive effect or event listener) goes onto `stops` as it attaches, so a binding that throws
 * midway leaves the earlier ones disposable; `stops` is returned. */
export function bindScope(
  root: BindableRoot,
  scope: IslandScope,
  stops: Array<() => void> = [],
): Array<() => void> {
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
      if (process.env.NODE_ENV !== "production") {
        // Empty server text is a slot the island fills, not a mismatch.
        // Untracked: a read here must not subscribe an effect this mount runs inside.
        const server = (el.textContent ?? "").trim()
        const state = untrack(() => String(s())).trim()
        if (server !== "" && server !== state) warnDrift("data-bind-text", name, server, state)
      }
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
      if (process.env.NODE_ENV !== "production") {
        const hidden = untrack(() => !s())
        if (el.hidden !== hidden)
          warnDrift("data-bind-show", name, `hidden=${el.hidden}`, `hidden=${hidden}`)
      }
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
      const isUrl = URL_ATTRIBUTE.test(attr)
      const tag = el.localName ?? el.tagName ?? ""
      if (CODE_ATTRIBUTE.test(attr) || (isUrl && URL_BLOCKED_TAG.test(tag)) || SMIL_TAG.test(tag)) {
        warnOnce("attribute", attr)
        continue
      }
      const s = named("signal", scope.signals, name)
      if (s) {
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
