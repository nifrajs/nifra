import { describe, expect, test } from "bun:test"
import { h } from "preact"
import { renderToString } from "preact-render-to-string"
import { I18nProvider, rich, useT } from "../src/i18n.ts"

const messages = { greeting: "Hi {name} - {n, plural, one {# message} other {# messages}}" }

function Greeting(props: { name: string; n: number }) {
  const { t, locale, n: num } = useT()
  return h(
    "p",
    { "data-locale": locale, "data-num": num(1234.5) },
    t("greeting", { name: props.name, n: props.n }),
  )
}

describe("@nifrajs/web-preact/i18n", () => {
  test("I18nProvider provides a formatter; useT renders translated text (SSR)", () => {
    const html = renderToString(
      h(I18nProvider, { locale: "en", messages }, h(Greeting, { name: "Ada", n: 1 })),
    )
    expect(html).toContain("Hi Ada - 1 message")
    expect(html).toContain('data-locale="en"')
    expect(html).toContain('data-num="1,234.5"')
  })

  test("plural switches with the count", () => {
    const html = renderToString(
      h(I18nProvider, { locale: "en", messages }, h(Greeting, { name: "Bo", n: 5 })),
    )
    expect(html).toContain("Hi Bo - 5 messages")
  })

  test("useT() outside a provider throws", () => {
    expect(() => renderToString(h(Greeting, { name: "x", n: 2 }))).toThrow(
      /within an <I18nProvider>/,
    )
  })

  test("fallback, onMissing and numberingSystem reach the formatter", () => {
    const missing: string[] = []
    const onMissing = (key: string) => missing.push(key)
    function Page() {
      const { t } = useT()
      return h("p", null, `${t("own")}|${t("greeting", { name: "Ada", n: 12 })}|${t("gone")}`)
    }
    const html = renderToString(
      h(
        I18nProvider,
        {
          locale: "hi",
          messages: { own: "अपना" },
          fallback: [messages],
          numberingSystem: "deva",
          onMissing,
        },
        h(Page, null),
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
  return h(
    "p",
    null,
    rich(
      t,
      "terms",
      {
        link: (content) => h("a", { href: "/terms" }, content),
        b: (content) => h("strong", null, content),
      },
      { name: "<b>Ada</b>" },
    ),
  )
}

test("rich() renders tags as elements and values as text", () => {
  const html = renderToString(
    h(I18nProvider, { locale: "en", messages: richMessages }, h(Terms, {})),
  )
  expect(html).toBe(
    '<p>Read the <a href="/terms">terms and <strong>all</strong> rules</a>,<br/>&lt;b>Ada&lt;/b>! x</p>',
  )
})
