import { expect, test } from "bun:test"
import type { RenderProps, RouterState } from "@nifrajs/web"
import { createSSRApp, defineComponent, h } from "vue"
import { renderToString } from "vue/server-renderer"
import { compose } from "../src/compose.ts"
import { routeProps } from "../src/route-props.ts"
import { useMatches } from "../src/router.ts"

/** Renders what `useMatches` reports, from wherever it sits in the chain. */
const Report = (where: string) =>
  defineComponent({
    props: ["data"],
    setup(_props, { slots }) {
      const matches = useMatches()
      return () => {
        const seen = matches.value.map((m) => [m.id, m.pathname, m.handle, m.data])
        return h("div", { "data-at": where }, [JSON.stringify(seen), slots.default?.()])
      }
    },
  })

// Vue escapes text content, so `{"a":1}` arrives as `{&quot;a&quot;:1}`. The page's root element also
// carries its fallthrough attributes (`path`), so each report is read by its text alone.
const render = async (props: RenderProps): Promise<string> =>
  (
    await renderToString(
      createSSRApp({ render: () => compose([Report("layout"), Report("page")], props) }),
    )
  ).replaceAll("&quot;", String.fromCharCode(34))

const matchChain = { ids: ["_layout", "orgs/[org]"], handles: ["Home", { crumb: "Org" }] }
const expected = JSON.stringify([
  ["_layout", "/", "Home", { user: "ada" }],
  ["orgs/[org]", "/orgs/acme", { crumb: "Org" }, { org: "acme" }],
])

test("useMatches reports the whole chain to a layout and to the page", async () => {
  const out = await render({
    data: { org: "acme" },
    layoutData: [{ user: "ada" }],
    params: { org: "acme" },
    path: "/orgs/acme",
    matchChain,
  })
  expect(out).toContain(`data-at="layout">${expected}`)
  expect(out).toContain(`">${expected}<!----></div>`)
  // The chain is plumbing, not page data: it never reaches the page's root element.
  expect(out.toLowerCase()).not.toContain("matchchain")
})

test("the mounted router reports what the server rendered", async () => {
  // The server passes `matchChain`; the client gets the same entry from the generated entry's table.
  const state: RouterState = {
    routeId: "orgs/[org]",
    params: { org: "acme" },
    path: "/orgs/acme",
    data: { org: "acme" },
    layoutData: [{ user: "ada" }],
    pending: false,
  }
  const out = await render(routeProps(state, undefined, { "orgs/[org]": matchChain }))
  expect(out).toContain(`">${expected}<!----></div>`)
})

test("a render without a chain reports nothing", async () => {
  expect(await render({ data: null, path: "/" })).toContain('">[]<!----></div>')
})
