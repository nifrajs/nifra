import { expect, test } from "bun:test"
import type { RenderProps, RouterState } from "@nifrajs/web"
import { createElement, type ReactNode } from "react"
import { compose } from "../src/compose.ts"
import { reactAdapter } from "../src/index.ts"
import { routeProps } from "../src/route-props.ts"
import { useMatches } from "../src/router.ts"

const html = async (node: ReactNode): Promise<string> => {
  const stream = await reactAdapter.renderToStream([() => node], { data: null })
  return (await new Response(stream).text()).replaceAll("&quot;", String.fromCharCode(34))
}

/** Renders what `useMatches` reports, from wherever it sits in the chain. */
const Report = (where: string) =>
  function Reporter(props: { children?: ReactNode }) {
    const matches = useMatches().map((m) => [m.id, m.pathname, m.handle, m.data])
    return createElement("div", { "data-at": where }, JSON.stringify(matches), props.children)
  }

const chain = [Report("layout"), Report("page")]
const matchChain = { ids: ["_layout", "orgs/[org]"], handles: ["Home", { crumb: "Org" }] }
const expected = JSON.stringify([
  ["_layout", "/", "Home", { user: "ada" }],
  ["orgs/[org]", "/orgs/acme", { crumb: "Org" }, { org: "acme" }],
])

test("useMatches reports the whole chain to a layout and to the page", async () => {
  const server: RenderProps = {
    data: { org: "acme" },
    layoutData: [{ user: "ada" }],
    params: { org: "acme" },
    path: "/orgs/acme",
    matchChain,
  }
  const out = await html(compose(chain, server))
  expect(out).toContain(`data-at="layout">${expected}`)
  expect(out).toContain(`data-at="page">${expected}`)
})

test("the mounted router reports what the server rendered", async () => {
  // The server passes `matchChain`; the client gets the same entry from the generated entry's table.
  // A difference is a hydration mismatch in every layout that renders breadcrumbs.
  const state: RouterState = {
    routeId: "orgs/[org]",
    params: { org: "acme" },
    path: "/orgs/acme",
    data: { org: "acme" },
    layoutData: [{ user: "ada" }],
    pending: false,
  }
  const props = routeProps(state, undefined, { "orgs/[org]": matchChain })
  const out = await html(compose(chain, props))
  expect(out).toContain(`data-at="page">${expected}`)
})

test("a render without a chain reports nothing", async () => {
  const out = await html(compose(chain, { data: null, path: "/" }))
  expect(out).toContain('data-at="page">[]')
})
