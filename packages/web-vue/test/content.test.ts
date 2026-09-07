import { expect, test } from "bun:test"
import { trustHtml } from "@nifrajs/web"
import { createSSRApp, h } from "vue"
import { renderToString } from "vue/server-renderer"
import { Content } from "../src/content.ts"

test("Content injects raw HTML (not escaped)", async () => {
  const html = await renderToString(
    createSSRApp({ render: () => h(Content, { html: trustHtml("<em>raw &amp; real</em>") }) }),
  )
  expect(html).toContain("<em>raw &amp; real</em>")
  expect(html).toContain("<div")
})

test("Content honors `as` + passes attrs through", async () => {
  const html = await renderToString(
    createSSRApp({
      render: () => h(Content, { html: trustHtml("<p>x</p>"), as: "article", class: "prose" }),
    }),
  )
  expect(html).toContain("<article")
  expect(html).toContain("prose")
})
