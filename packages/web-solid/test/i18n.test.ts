import { describe, expect, test } from "bun:test"
import { LOCALES_GLOBAL, type RenderProps } from "@nifrajs/web"
import { createComponent, type JSX } from "solid-js"
import { Dynamic, renderToString } from "solid-js/web"
import { I18nProvider, rich, useLocale, useT } from "../src/i18n.ts"
import { RenderPropsContext } from "../src/router.ts"

const messages = { greeting: "Hi {name} - {n, plural, one {# message} other {# messages}}" }

const Greeting = (props: { name: string; n: number }): JSX.Element => {
  const f = useT()
  return createComponent(Dynamic, {
    component: "p",
    "data-locale": f.locale,
    "data-num": f.n(1234.5),
    get children() {
      return f.t("greeting", { name: props.name, n: props.n })
    },
  })
}

const inProvider = (slot: () => JSX.Element): string =>
  renderToString(() =>
    createComponent(I18nProvider, {
      locale: "en",
      messages,
      get children() {
        return slot()
      },
    }),
  )

describe("@nifrajs/web-solid/i18n", () => {
  test("I18nProvider provides a formatter; useT renders translated text (SSR)", () => {
    const html = inProvider(() => createComponent(Greeting, { name: "Ada", n: 1 }))
    expect(html).toContain("Hi Ada - 1 message")
    expect(html).toContain('data-locale="en"')
    expect(html).toContain('data-num="1,234.5"')
  })

  test("plural switches with the count", () => {
    const html = inProvider(() => createComponent(Greeting, { name: "Bo", n: 5 }))
    expect(html).toContain("Hi Bo - 5 messages")
  })

  test("useT() outside a provider throws", () => {
    expect(() => renderToString(() => createComponent(Greeting, { name: "x", n: 2 }))).toThrow(
      /within an <I18nProvider>/,
    )
  })

  test("fallback, onMissing and numberingSystem reach the formatter", () => {
    const missing: string[] = []
    const onMissing = (key: string) => missing.push(key)
    const Page = (): JSX.Element => {
      const { t } = useT()
      return `${t("own")}|${t("greeting", { name: "Ada", n: 12 })}|${t("gone")}`
    }
    const html = renderToString(() =>
      createComponent(I18nProvider, {
        locale: "hi",
        messages: { own: "अपना" },
        fallback: [messages],
        numberingSystem: "deva",
        onMissing,
        get children() {
          return createComponent(Page, {})
        },
      }),
    )
    expect(html).toContain("अपना|Hi Ada - १२ messages|gone")
    expect(missing).toEqual(["gone"])
  })
})

test("rich() renders tags as elements and values as text", () => {
  const html = renderToString(() =>
    createComponent(I18nProvider, {
      locale: "en",
      messages: {
        terms: "Read the <link>terms and <b>all</b> rules</link>,<br/>{name}! <em>x</em>",
      },
      get children() {
        const t = useT()
        return createComponent(Dynamic, {
          component: "p",
          get children() {
            return rich(
              t,
              "terms",
              {
                link: (content) =>
                  createComponent(Dynamic, { component: "a", href: "/terms", children: content }),
                b: (content) =>
                  createComponent(Dynamic, { component: "strong", children: content }),
              },
              { name: "<b>Ada</b>" },
            )
          },
        })
      },
    }),
  )
  // Hydration keys and markers are Solid's, not part of what renders.
  const visible = html
    .replace(/ data-hk="[^"]*"/g, "")
    .split(/<!--[\s\S]*?-->/)
    .join("")
    .replace(/ +(\/?>)/g, "$1")
  expect(visible).toBe(
    '<p>Read the <a href="/terms">terms and <strong>all</strong> rules</a>,<br/>&lt;b>Ada&lt;/b>! x</p>',
  )
})

describe("the page's locale", () => {
  const ur = { key: "ur", lang: "ur-PK", dir: "rtl" } as const
  const Locale = (): JSX.Element => {
    const key = useLocale()
    const f = useT()
    return createComponent(Dynamic, {
      component: "p",
      get children() {
        return `${key()}|${f.locale}`
      },
    })
  }
  const page = (renderProps: RenderProps | undefined, locale?: string): string =>
    renderToString(() => {
      const child = () => createComponent(Locale, {})
      const provider = () =>
        locale === undefined
          ? createComponent(I18nProvider, {
              messages,
              get children() {
                return child()
              },
            })
          : createComponent(I18nProvider, {
              locale,
              messages,
              get children() {
                return child()
              },
            })
      return renderProps === undefined
        ? provider()
        : createComponent(RenderPropsContext.Provider, {
            value: renderProps,
            get children() {
              return provider()
            },
          })
    })

  test("on the server, useLocale and <I18nProvider> read the request's locale", () => {
    expect(page({ data: null, path: "/ur/x", locale: ur })).toContain("ur|ur-PK")
  })

  test("in the browser, the handed-over locales name it from the path", () => {
    Reflect.set(globalThis, LOCALES_GLOBAL, {
      default: "en",
      locales: [ur, { key: "en", lang: "en", dir: "ltr" }],
    })
    try {
      expect(page({ data: null, path: "/ur/x" })).toContain("ur|ur-PK")
    } finally {
      Reflect.deleteProperty(globalThis, LOCALES_GLOBAL)
    }
  })

  test("an explicit locale wins; without routing useLocale reads the provider; with neither, both throw", () => {
    expect(page({ data: null, path: "/ur/x", locale: ur }, "fr")).toContain("ur|fr")
    expect(page(undefined, "fr")).toContain("fr|fr")
    expect(() => page(undefined)).toThrow("<I18nProvider> needs a `locale`")
    expect(() =>
      renderToString(() =>
        createComponent(Dynamic, {
          component: "p",
          get children() {
            return useLocale()()
          },
        }),
      ),
    ).toThrow("useLocale() needs an app that registers its locale routing")
  })
})
