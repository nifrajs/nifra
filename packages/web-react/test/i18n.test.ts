import { describe, expect, test } from "bun:test"
import { LOCALES_GLOBAL, type RenderProps } from "@nifrajs/web"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { I18nProvider, rich, useLocale, useT } from "../src/i18n.ts"
import { RouterContext } from "../src/router.ts"

const messages = { greeting: "Hi {name} - {n, plural, one {# message} other {# messages}}" }

function Greeting(props: { name: string; n: number }) {
  const { t, locale, n: num } = useT()
  return createElement(
    "p",
    { "data-locale": locale, "data-num": num(1234.5) },
    t("greeting", { name: props.name, n: props.n }),
  )
}

describe("@nifrajs/web-react/i18n", () => {
  test("I18nProvider provides a formatter; useT renders translated text (SSR)", () => {
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        { locale: "en", messages },
        createElement(Greeting, { name: "Ada", n: 1 }),
      ),
    )
    expect(html).toContain("Hi Ada - 1 message")
    expect(html).toContain('data-locale="en"')
    expect(html).toContain('data-num="1,234.5"') // en number formatting via the formatter's n()
  })

  test("plural switches with the count", () => {
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        { locale: "en", messages },
        createElement(Greeting, { name: "Bo", n: 5 }),
      ),
    )
    expect(html).toContain("Hi Bo - 5 messages")
  })

  test("useT() outside a provider throws", () => {
    expect(() => renderToStaticMarkup(createElement(Greeting, { name: "x", n: 2 }))).toThrow(
      /within an <I18nProvider>/,
    )
  })

  test("fallback, onMissing and numberingSystem reach the formatter", () => {
    const missing: string[] = []
    const onMissing = (key: string) => missing.push(key)
    function Page() {
      const { t } = useT()
      return createElement(
        "p",
        null,
        `${t("own")}|${t("greeting", { name: "Ada", n: 12 })}|${t("gone")}`,
      )
    }
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        {
          locale: "hi",
          messages: { own: "अपना" },
          fallback: [messages],
          numberingSystem: "deva",
          onMissing,
        },
        createElement(Page),
      ),
    )
    expect(html).toContain("अपना|Hi Ada - १२ messages|gone")
    expect(missing).toEqual(["gone"])
  })
})

const richMessages = {
  terms: "Read the <link>terms and <b>all</b> rules</link>,<br/>{name}! <em>x</em>",
}

function Terms() {
  const t = useT()
  return createElement(
    "p",
    null,
    rich(
      t,
      "terms",
      {
        link: (content) => createElement("a", { href: "/terms" }, content),
        b: (content) => createElement("strong", null, content),
      },
      { name: "<b>Ada</b>" },
    ),
  )
}

test("rich() renders tags as elements, values as text, and asks React for no keys", () => {
  const errors: unknown[] = []
  const original = console.error
  console.error = (...args: unknown[]) => errors.push(args)
  try {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, { locale: "en", messages: richMessages }, createElement(Terms)),
    )
    expect(html).toBe(
      '<p>Read the <a href="/terms">terms and <strong>all</strong> rules</a>,<br/>&lt;b&gt;Ada&lt;/b&gt;! x</p>',
    )
  } finally {
    console.error = original
  }
  expect(errors).toEqual([])
})

describe("the page's locale", () => {
  const ur = { key: "ur", lang: "ur-PK", dir: "rtl" } as const
  function Locale() {
    const key = useLocale()
    return createElement("p", null, `${key}|${useT().locale}`)
  }
  function KeyOnly() {
    return createElement("p", null, useLocale())
  }
  const onPage = (renderProps: RenderProps, child: ReturnType<typeof createElement>) =>
    createElement(
      RouterContext.Provider,
      {
        value: {
          params: {},
          path: renderProps.path ?? "",
          search: {},
          pending: false,
          renderProps,
        },
      },
      child,
    )
  const provided = () => createElement(I18nProvider, { messages }, createElement(Locale))

  test("on the server, useLocale and <I18nProvider> read the request's locale", () => {
    const html = renderToStaticMarkup(onPage({ data: null, path: "/ur/x", locale: ur }, provided()))
    expect(html).toContain("ur|ur-PK")
  })

  test("in the browser, the handed-over locales name it from the path", () => {
    Reflect.set(globalThis, LOCALES_GLOBAL, {
      default: "en",
      locales: [ur, { key: "en", lang: "en", dir: "ltr" }],
    })
    try {
      expect(renderToStaticMarkup(onPage({ data: null, path: "/ur/x" }, provided()))).toContain(
        "ur|ur-PK",
      )
      expect(renderToStaticMarkup(onPage({ data: null, path: "/x" }, provided()))).toContain(
        "en|en",
      )
    } finally {
      Reflect.deleteProperty(globalThis, LOCALES_GLOBAL)
    }
  })

  test("an explicit locale wins; without routing useLocale reads the provider; with neither, both throw", () => {
    const explicit = createElement(I18nProvider, { locale: "fr", messages }, createElement(Locale))
    expect(
      renderToStaticMarkup(onPage({ data: null, path: "/ur/x", locale: ur }, explicit)),
    ).toContain("ur|fr")
    expect(renderToStaticMarkup(explicit)).toContain("fr|fr")
    expect(() => renderToStaticMarkup(provided())).toThrow("<I18nProvider> needs a `locale`")
    expect(() => renderToStaticMarkup(createElement(KeyOnly))).toThrow(
      "useLocale() needs an app that registers its locale routing",
    )
  })
})
