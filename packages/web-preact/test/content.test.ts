import { expect, test } from "bun:test"
import { trustHtml } from "@nifrajs/web"
import { h } from "preact"
import { renderToString } from "preact-render-to-string"
import { Content } from "../src/content.ts"

test("Content injects raw HTML (not escaped)", () => {
  const html = renderToString(h(Content, { html: trustHtml("<em>raw &amp; real</em>") }))
  expect(html).toContain("<em>raw &amp; real</em>")
  expect(html).toContain("<div")
})

test("Content honors `as` + passes DOM props through", () => {
  const html = renderToString(
    h(Content, { html: trustHtml("<p>x</p>"), as: "article", class: "prose" }),
  )
  expect(html).toContain("<article")
  expect(html).toContain('class="prose"')
})
