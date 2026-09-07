import { expect, test } from "bun:test"
import { trustHtml } from "@nifrajs/web"
import { renderToString } from "solid-js/web"
import { Content } from "../src/content.ts"

test("Content injects raw HTML (not escaped)", () => {
  const html = renderToString(() => Content({ html: trustHtml("<em>raw &amp; real</em>") }))
  expect(html).toContain("<em>raw &amp; real</em>")
})

test("Content honors `as` + passes props through", () => {
  const html = renderToString(() =>
    Content({ html: trustHtml("<p>x</p>"), as: "article", class: "prose" }),
  )
  expect(html).toContain("<article")
  expect(html).toContain("prose")
})
