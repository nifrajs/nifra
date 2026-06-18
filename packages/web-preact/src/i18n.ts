/**
 * `@nifrajs/web-preact/i18n` — Preact bindings for `@nifrajs/i18n`. `<I18nProvider locale messages>` builds a
 * `Formatter` (memoized) and provides it; `useT()` reads it. Both `locale` + `messages` are
 * serializable, so a loader returns them, the page renders with the negotiated catalog on the server,
 * and the client rebuilds the same formatter from the same props (no mismatch). Uses `preact` +
 * `preact/hooks` — no JSX.
 */
import { createFormatter, type Formatter, type Messages } from "@nifrajs/i18n"
import { type ComponentChildren, createContext, createElement, type VNode } from "preact"
import { useContext, useMemo } from "preact/hooks"

const I18nContext = createContext<Formatter | null>(null)

// Preact's `createElement` overloads don't reconcile a typed `Context.Provider` (required `value`)
// under `exactOptionalPropertyTypes` — overload resolution drops `value` and infers the props as `{}`.
// The call is correct at runtime (proven by the tests), so invoke it through a precisely-typed element
// factory that states the real contract (`{ value }` + children), rather than scatter `any`.
const createProvider = createElement as (
  type: typeof I18nContext.Provider,
  props: { value: Formatter | null },
  children?: ComponentChildren,
) => VNode

export interface I18nProviderProps {
  readonly locale: string
  readonly messages: Messages
  readonly children?: ComponentChildren
}

/** Provide a {@link Formatter} (built from `locale` + `messages`) to the subtree. Memoized on
 * `locale`/`messages`, so switching locale rebuilds it and re-renders consumers. */
export function I18nProvider(props: I18nProviderProps): VNode {
  const formatter = useMemo(
    () => createFormatter(props.locale, props.messages),
    [props.locale, props.messages],
  )
  return createProvider(I18nContext.Provider, { value: formatter }, props.children)
}

/** Read the current {@link Formatter} (`{ locale, t, n, d }`). Throws if no `<I18nProvider>` is above. */
export function useT(): Formatter {
  const formatter = useContext(I18nContext)
  if (formatter === null) {
    throw new Error("[nifra/web-preact] useT() must be used within an <I18nProvider>")
  }
  return formatter
}
