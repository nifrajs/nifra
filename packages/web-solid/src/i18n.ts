/**
 * `@nifrajs/web-solid/i18n` - Solid bindings for `@nifrajs/i18n`. `<I18nProvider locale messages>` builds a
 * `Formatter` (a `createMemo`, so switching locale rebuilds it) and provides it; `useT()` reads it.
 * Both `locale` + `messages` are serializable, so a loader returns them, the page renders with the
 * negotiated catalog on the server, and the client rebuilds the same formatter on hydrate (no
 * mismatch). Imports only `solid-js` + `@nifrajs/i18n`; no JSX (`createComponent`).
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
import {
  type Accessor,
  createComponent,
  createContext,
  createMemo,
  type JSX,
  useContext,
} from "solid-js"
import { Dynamic } from "solid-js/web"

const I18nContext = createContext<Accessor<Formatter>>()

export interface I18nProviderProps extends FormatterOptions {
  readonly locale: string
  /** The catalog for `locale`, checked against the registered catalog type when one is declared. */
  readonly messages: Translation
  readonly children?: JSX.Element
}

/** Provide a {@link Formatter} (built from `locale` + `messages`, with the optional `fallback`,
 * `onMissing`, `timeZone` and `numberingSystem` of `createFormatter`) to the subtree. Memoized
 * on those props, so switching locale rebuilds it. */
export function I18nProvider(props: I18nProviderProps): JSX.Element {
  const formatter = createMemo(() =>
    createFormatter(props.locale, props.messages, {
      fallback: props.fallback,
      onMissing: props.onMissing,
      timeZone: props.timeZone,
      numberingSystem: props.numberingSystem,
    }),
  )
  return createComponent(I18nContext.Provider, {
    value: formatter,
    get children() {
      return props.children
    },
  })
}

/** Read the current {@link Formatter} (`{ locale, t, get, n, d }`). Throws if no `<I18nProvider>` is above.
 * nifra switches locale by re-navigating, which re-runs the consuming component with the new catalog. */
export function useT(): Formatter {
  const formatter = useContext(I18nContext)
  if (formatter === undefined) {
    throw new Error("[nifra/web-solid] useT() must be used within an <I18nProvider>")
  }
  return formatter()
}

/** Tag handlers for {@link rich}, by tag name: each receives its tag's content as one node. */
export type RichTags = Readonly<Record<string, (content: JSX.Element) => JSX.Element>>

const join = (chunks: RichChunks<JSX.Element>): JSX.Element =>
  chunks.length === 0 ? undefined : chunks.length === 1 ? chunks[0] : [...chunks]
const SOLID_RICH: RichRenderer<JSX.Element> = {
  join,
  lineBreak: () => createComponent(Dynamic, { component: "br" }),
}

/**
 * The message at `key` with its tags rendered by `tags`, as Solid nodes - no HTML, no `innerHTML`.
 * `"Read the <link>terms</link>"` with `{ link: (content) => <a href="/terms">{content}</a> }`
 * renders the link around "terms"; a tag with no handler renders its content as text, `<br/>` is a
 * `<br>`, and interpolated values are always text. It runs once: wrap the call in a function
 * (`{() => rich(t, key, tags, { n: count() })}`) to track signals in `vars`. See `@nifrajs/i18n/rich`.
 */
export function rich<M extends object = RegisteredMessages>(
  formatter: Formatter<M>,
  key: MessageKey<M>,
  tags?: RichTags,
  vars?: Readonly<Record<string, unknown>>,
): JSX.Element {
  return renderRich(SOLID_RICH, formatter, key, tags, vars)
}
