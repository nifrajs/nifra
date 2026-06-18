import { expect, test } from "bun:test"
import { createSSRApp, h } from "vue"
import { renderToString } from "vue/server-renderer"
import { Content } from "../src/content.ts"

test("Content injects raw HTML (not escaped)", async () => {
  const html = await renderToString(
    createSSRApp({ render: () => h(Content, { html: "<em>raw &amp; real</em>" }) }),
  )
  expect(html).toContain("<em>raw &amp; real</em>")
  expect(html).toContain("<div")
})

test("Content honors `as` + passes attrs through", async () => {
  const html = await renderToString(
    createSSRApp({ render: () => h(Content, { html: "<p>x</p>", as: "article", class: "prose" }) }),
  )
  expect(html).toContain("<article")
  expect(html).toContain("prose")
})
