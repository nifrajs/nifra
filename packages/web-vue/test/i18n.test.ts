import { describe, expect, test } from "bun:test"
import { createSSRApp, defineComponent, h } from "vue"
import { renderToString } from "vue/server-renderer"
import { I18nProvider, useT } from "../src/i18n.ts"

const messages = { greeting: "Hi {name} — {n, plural, one {# message} other {# messages}}" }

const Greeting = defineComponent({
  props: { name: { type: String, required: true }, n: { type: Number, required: true } },
  setup(props) {
    const { t, locale, n: num } = useT()
    return () =>
      h(
        "p",
        { "data-locale": locale, "data-num": num(1234.5) },
        t("greeting", { name: props.name, n: props.n }),
      )
  },
})

const render = (slot: () => unknown): Promise<string> =>
  renderToString(
    createSSRApp({ render: () => h(I18nProvider, { locale: "en", messages }, { default: slot }) }),
  )

describe("@nifrajs/web-vue/i18n", () => {
  test("I18nProvider provides a formatter; useT renders translated text (SSR)", async () => {
    const html = await render(() => h(Greeting, { name: "Ada", n: 1 }))
    expect(html).toContain("Hi Ada — 1 message")
    expect(html).toContain('data-locale="en"')
    expect(html).toContain('data-num="1,234.5"')
  })

  test("plural switches with the count", async () => {
    const html = await render(() => h(Greeting, { name: "Bo", n: 5 }))
    expect(html).toContain("Hi Bo — 5 messages")
  })

  test("useT() outside a provider throws", () => {
    expect(
      renderToString(createSSRApp({ render: () => h(Greeting, { name: "x", n: 2 }) })),
    ).rejects.toThrow(/within an <I18nProvider>/)
  })
})
