import { expect, test } from "bun:test"
import type { RenderProps, RouterState } from "@nifrajs/web"
import { type ComponentChildren, h } from "preact"
import { renderToString } from "preact-render-to-string"
import { compose } from "../src/compose.ts"
import { routeProps } from "../src/route-props.ts"
import { useMatches } from "../src/router.ts"

// Preact escapes text content, so `{"a":1}` arrives as `{&quot;a&quot;:1}`.
const render = (props: RenderProps): string =>
  renderToString(compose(chain, props)).replaceAll("&quot;", String.fromCharCode(34))

/** Renders what `useMatches` reports, from wherever it sits in the chain. */
const Report = (where: string) => (props: { children?: ComponentChildren }) => {
  const matches = useMatches().map((m) => [m.id, m.pathname, m.handle, m.data])
  return h("div", { "data-at": where }, JSON.stringify(matches), props.children)
}

const chain = [Report("layout"), Report("page")]
const matchChain = { ids: ["_layout", "orgs/[org]"], handles: ["Home", { crumb: "Org" }] }
const expected = JSON.stringify([
  ["_layout", "/", "Home", { user: "ada" }],
  ["orgs/[org]", "/orgs/acme", { crumb: "Org" }, { org: "acme" }],
])

test("useMatches reports the whole chain to a layout and to the page", () => {
  const out = render({
    data: { org: "acme" },
    layoutData: [{ user: "ada" }],
    params: { org: "acme" },
    path: "/orgs/acme",
    matchChain,
  })
  expect(out).toContain(`data-at="layout">${expected}`)
  expect(out).toContain(`data-at="page">${expected}`)
})

test("the mounted router reports what the server rendered", () => {
  // The server passes `matchChain`; the client gets the same entry from the generated entry's table.
  const state: RouterState = {
    routeId: "orgs/[org]",
    params: { org: "acme" },
    path: "/orgs/acme",
    data: { org: "acme" },
    layoutData: [{ user: "ada" }],
    pending: false,
  }
  expect(render(routeProps(state, undefined, { "orgs/[org]": matchChain }))).toContain(
    `data-at="page">${expected}`,
  )
})

test("a render without a chain reports nothing", () => {
  expect(render({ data: null, path: "/" })).toContain('data-at="page">[]')
})
