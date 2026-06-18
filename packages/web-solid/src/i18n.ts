/**
 * `@nifrajs/web-solid/i18n` — Solid bindings for `@nifrajs/i18n`. `<I18nProvider locale messages>` builds a
 * `Formatter` (a `createMemo`, so switching locale rebuilds it) and provides it; `useT()` reads it.
 * Both `locale` + `messages` are serializable, so a loader returns them, the page renders with the
 * negotiated catalog on the server, and the client rebuilds the same formatter on hydrate (no
 * mismatch). Imports only `solid-js` + `@nifrajs/i18n`; no JSX (`createComponent`).
 */
import { createFormatter, type Formatter, type Messages } from "@nifrajs/i18n"
import {
  type Accessor,
  createComponent,
  createContext,
  createMemo,
  type JSX,
  useContext,
} from "solid-js"

const I18nContext = createContext<Accessor<Formatter>>()

export interface I18nProviderProps {
  readonly locale: string
  readonly messages: Messages
  readonly children?: JSX.Element
}

/** Provide a {@link Formatter} (built from `locale` + `messages`) to the subtree. Memoized on
 * `locale`/`messages`, so switching locale rebuilds it. */
export function I18nProvider(props: I18nProviderProps): JSX.Element {
  const formatter = createMemo(() => createFormatter(props.locale, props.messages))
  return createComponent(I18nContext.Provider, {
    value: formatter,
    get children() {
      return props.children
    },
  })
}

/** Read the current {@link Formatter} (`{ locale, t, n, d }`). Throws if no `<I18nProvider>` is above.
 * nifra switches locale by re-navigating, which re-runs the consuming component with the new catalog. */
export function useT(): Formatter {
  const formatter = useContext(I18nContext)
  if (formatter === undefined) {
    throw new Error("[nifra/web-solid] useT() must be used within an <I18nProvider>")
  }
  return formatter()
}
