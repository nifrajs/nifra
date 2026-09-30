import { expect, test } from "bun:test"
import type { RenderProps, RouterState } from "@nifrajs/web"
import type { JSX } from "solid-js"
import { renderToString } from "solid-js/web"
import { compose } from "../src/compose.ts"
import { routeProps } from "../src/route-props.ts"
import { useMatches } from "../src/router.ts"

// Solid escapes text content, so `<` and `"` arrive as entities.
const decode = (html: string): string =>
  html.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", String.fromCharCode(34))

/** Renders what `useMatches` reports, from wherever it sits in the chain. */
const Report = (where: string) => (props: { children?: JSX.Element }) => {
  const matches = useMatches()
  const seen = matches().map((m) => [m.id, m.pathname, m.handle, m.data])
  return [`<${where}:${JSON.stringify(seen)}>`, props.children] as unknown as JSX.Element
}

const render = (props: RenderProps): string =>
  decode(renderToString(compose([Report("layout"), Report("page")], props)))

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
  expect(out).toContain(`<layout:${expected}>`)
  expect(out).toContain(`<page:${expected}>`)
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
  const props = routeProps(() => state, undefined, { "orgs/[org]": matchChain })
  expect(render(props)).toContain(`<page:${expected}>`)
})

test("a render without a chain reports nothing", () => {
  expect(render({ data: null, path: "/" })).toContain("<page:[]>")
})
