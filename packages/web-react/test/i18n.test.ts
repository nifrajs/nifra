import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { I18nProvider, rich, useT } from "../src/i18n.ts"

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
