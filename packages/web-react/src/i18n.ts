/**
 * `@nifrajs/web-react/i18n` — React bindings for `@nifrajs/i18n`. `<I18nProvider locale messages>` builds a
 * `Formatter` (memoized) and provides it; `useT()` reads it. Both `locale` + `messages` are
 * serializable, so a loader returns them, the page renders with the negotiated catalog on the server,
 * and the client rebuilds the same formatter from the same props (no mismatch). Imports only `react` +
 * `@nifrajs/i18n`; no JSX (the package builds with plain `tsc`).
 */
import { createFormatter, type Formatter, type Messages } from "@nifrajs/i18n"
import { createContext, createElement, type ReactNode, useContext, useMemo } from "react"

const I18nContext = createContext<Formatter | null>(null)

export interface I18nProviderProps {
  readonly locale: string
  readonly messages: Messages
  readonly children?: ReactNode
}

/** Provide a {@link Formatter} (built from `locale` + `messages`) to the subtree. Memoized on
 * `locale`/`messages`, so switching locale rebuilds it and re-renders consumers. */
export function I18nProvider(props: I18nProviderProps): ReactNode {
  const formatter = useMemo(
    () => createFormatter(props.locale, props.messages),
    [props.locale, props.messages],
  )
  return createElement(I18nContext.Provider, { value: formatter }, props.children)
}

/** Read the current {@link Formatter} (`{ locale, t, n, d }`). Throws if no `<I18nProvider>` is above. */
export function useT(): Formatter {
  const formatter = useContext(I18nContext)
  if (formatter === null) {
    throw new Error("[nifra/web-react] useT() must be used within an <I18nProvider>")
  }
  return formatter
}
