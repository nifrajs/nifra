/**
 * `@nifrajs/web-react/i18n` - React bindings for `@nifrajs/i18n`. `<I18nProvider locale messages>` builds a
 * `Formatter` (memoized) and provides it; `useT()` reads it. Both `locale` + `messages` are
 * serializable, so a loader returns them, the page renders with the negotiated catalog on the server,
 * and the client rebuilds the same formatter from the same props (no mismatch). Imports only `react` +
 * `@nifrajs/i18n`; no JSX (the package builds with plain `tsc`).
 */
import {
  createFormatter,
  type Formatter,
  type FormatterOptions,
  type MessageKey,
  type RegisteredMessages,
  type Translation,
} from "@nifrajs/i18n"
import { type RichChunks, type RichRenderer, renderRich } from "@nifrajs/i18n/rich"
import { createContext, createElement, Fragment, type ReactNode, useContext, useMemo } from "react"

const I18nContext = createContext<Formatter | null>(null)

export interface I18nProviderProps extends FormatterOptions {
  readonly locale: string
  /** The catalog for `locale`, checked against the registered catalog type when one is declared. */
  readonly messages: Translation
  readonly children?: ReactNode
}

/** Provide a {@link Formatter} (built from `locale` + `messages`, with the optional `fallback`,
 * `onMissing`, `timeZone` and `numberingSystem` of `createFormatter`) to the subtree. Memoized
 * on those props, so switching locale rebuilds it and re-renders consumers; formatters are cached by
 * catalog identity, so an inline `fallback={[en]}` still yields the same instance. */
export function I18nProvider(props: I18nProviderProps): ReactNode {
  const { locale, messages, fallback, onMissing, timeZone, numberingSystem } = props
  const formatter = useMemo(
    () => createFormatter(locale, messages, { fallback, onMissing, timeZone, numberingSystem }),
    [locale, messages, fallback, onMissing, timeZone, numberingSystem],
  )
  return createElement(I18nContext.Provider, { value: formatter }, props.children)
}

/** Read the current {@link Formatter} (`{ locale, t, get, n, d }`). Throws if no `<I18nProvider>` is above. */
export function useT(): Formatter {
  const formatter = useContext(I18nContext)
  if (formatter === null) {
    throw new Error("[nifra/web-react] useT() must be used within an <I18nProvider>")
  }
  return formatter
}

/** Tag handlers for {@link rich}, by tag name: each receives its tag's content as one node. */
export type RichTags = Readonly<Record<string, (content: ReactNode) => ReactNode>>

// Children passed as arguments, not an array, so React asks for no keys.
const join = (chunks: RichChunks<ReactNode>): ReactNode =>
  chunks.length === 0
    ? null
    : chunks.length === 1
      ? chunks[0]
      : createElement(Fragment, null, ...chunks)
const REACT_RICH: RichRenderer<ReactNode> = { join, lineBreak: () => createElement("br") }

/**
 * The message at `key` with its tags rendered by `tags`, as React nodes - no HTML, no
 * `dangerouslySetInnerHTML`. `"Read the <link>terms</link>"` with
 * `{ link: (content) => <a href="/terms">{content}</a> }` renders the link around "terms"; a tag with
 * no handler renders its content as text, `<br/>` is a `<br>`, and interpolated values are always
 * text. See `@nifrajs/i18n/rich`.
 */
export function rich<M extends object = RegisteredMessages>(
  formatter: Formatter<M>,
  key: MessageKey<M>,
  tags?: RichTags,
  vars?: Readonly<Record<string, unknown>>,
): ReactNode {
  return renderRich(REACT_RICH, formatter, key, tags, vars)
}
