import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { Island } from "../src/island.ts"

describe("<Island> marker", () => {
  test("renders a <nifra-island> with id, strategy, and JSON-encoded props + its children", () => {
    const html = renderToString(
      createElement(
        Island,
        { id: "counter", strategy: "visible", props: { start: 3 } },
        createElement("button", { type: "button" }, "count"),
      ),
    )
    expect(html).toContain("<nifra-island")
    expect(html).toContain('data-island="counter"')
    expect(html).toContain('data-island-strategy="visible"')
    expect(html).toContain("data-island-props=")
    expect(html).toContain("start") // the props payload is present (React-escaped)
    expect(html).toContain('<button type="button">count</button>') // real HTML (works JS-off)
  })

  test("defaults strategy to load and omits data-island-props when there are none", () => {
    const html = renderToString(createElement(Island, { id: "x" }, "hi"))
    expect(html).toContain('data-island-strategy="load"')
    expect(html).not.toContain("data-island-props")
  })

  test("a media strategy renders the media marker the islands runtime reads", () => {
    const html = renderToString(
      createElement(Island, { id: "x", strategy: { media: "(min-width: 800px)" } }, "hi"),
    )
    expect(html).toContain('data-island-strategy="media"')
    expect(html).toContain('data-island-media="(min-width: 800px)"')
  })

  test("props can't break out of the attribute (React escapes the value)", () => {
    const html = renderToString(
      createElement(Island, {
        id: "x",
        props: { evil: '"></nifra-island><script>alert(1)</script>' },
      }),
    )
    expect(html).not.toContain('"></nifra-island><script>') // escaped, no markup breakout
  })
})
