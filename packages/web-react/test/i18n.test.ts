import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { I18nProvider, useT } from "../src/i18n.ts"

const messages = { greeting: "Hi {name} — {n, plural, one {# message} other {# messages}}" }

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
    expect(html).toContain("Hi Ada — 1 message")
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
    expect(html).toContain("Hi Bo — 5 messages")
  })

  test("useT() outside a provider throws", () => {
    expect(() => renderToStaticMarkup(createElement(Greeting, { name: "x", n: 2 }))).toThrow(
      /within an <I18nProvider>/,
    )
  })
})
