import { expect, test } from "bun:test"
import { trustHtml } from "@nifrajs/web"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Content } from "../src/content.ts"

test("Content injects raw HTML (not escaped)", () => {
  const html = renderToStaticMarkup(
    createElement(Content, { html: trustHtml("<em>raw &amp; real</em>") }),
  )
  expect(html).toContain("<em>raw &amp; real</em>") // injected verbatim, not re-escaped
  expect(html).toContain("<div") // default wrapper
})

test("Content honors `as` + passes DOM props through", () => {
  const html = renderToStaticMarkup(
    createElement(Content, {
      html: trustHtml("<p>x</p>"),
      as: "article",
      className: "prose",
      id: "post",
    }),
  )
  expect(html).toContain("<article")
  expect(html).toContain('class="prose"')
  expect(html).toContain('id="post"')
})
