import { describe, expect, test } from "bun:test"
import { createComponent, type JSX } from "solid-js"
import { Dynamic, renderToString } from "solid-js/web"
import { I18nProvider, rich, useT } from "../src/i18n.ts"

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
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/ +(\/?>)/g, "$1")
  expect(visible).toBe(
    '<p>Read the <a href="/terms">terms and <strong>all</strong> rules</a>,<br/>&lt;b>Ada&lt;/b>! x</p>',
  )
})
