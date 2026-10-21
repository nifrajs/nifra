import { expect, test } from "bun:test"
import { h } from "preact"
import { useId } from "preact/hooks"
import { renderToString } from "preact-render-to-string"
import { DATA_HEADER } from "../../web/src/router.ts"
import { nextSlowAbort, probe } from "../../web/test/fixtures/ppr/app/lib/probe.ts"
import { preactAdapter } from "../src/index.ts"
import { Hole, type HoleDefinition } from "../src/ppr.ts"
import { startPprApp } from "./fixtures/ppr-app/server.ts"

function Field(props: { readonly label: string }) {
  const id = useId()
  return h("span", null, h("label", { for: id }, props.label), h("input", { id }))
}

test("a hole's fragment renders inside renderFragment, its ids under the hole's own prefix", async () => {
  const renderFragment = preactAdapter.renderFragment?.bind(preactAdapter)
  let rendering = false
  const html = await renderFragment?.(
    () => {
      rendering = true
      return h(Field, { label: "qty" })
    },
    { idPrefix: "nifra-cart-" },
  )
  expect(rendering).toBe(true)
  expect(html).toBe(
    '<span><label for="Pnifra-cart--0">qty</label><input id="Pnifra-cart--0"/></span>',
  )
  expect(await renderFragment?.(() => h(Field, { label: "qty" }), {})).toBe(
    '<span><label for="P0-0">qty</label><input id="P0-0"/></span>',
  )
})

test("Hole renders an empty host for a shell, and the boundary's own states otherwise", () => {
  const of: HoleDefinition<{ readonly n: number }> = {
    name: "cart",
    render: (data) => h("p", null, `ready ${data.n}`),
    fallback: h("p", null, "waiting"),
  }
  const body = (state: Parameters<typeof Hole>[0]["state"]) =>
    renderToString(h(Hole<{ readonly n: number }>, { of, state, error: h("p", null, "failed") }))
  expect({
    shell: body({ status: "pending", ppr: true }),
    unrendered: body(undefined),
    ready: body({ status: "ready", data: { n: 1 } }),
    failed: body({ status: "error" }),
    streamedEmpty: body({ status: "pending" }),
    streamedValue: body({ status: "pending", data: { n: 2 } }),
  }).toEqual({
    shell: '<div data-nifra-hole="cart" aria-busy="true"></div>',
    unrendered: "<p>waiting</p>",
    ready: "<p>ready 1</p>",
    failed: "<p>failed</p>",
    streamedEmpty: "<p>waiting</p>",
    streamedValue: "<p>ready 2</p>",
  })
})

test("the Preact PPR app serves a checked shell and fills its holes after it", async () => {
  const app = await startPprApp()
  try {
    const response = await fetch(`${app.origin}/p/1`, { headers: { cookie: "name=ada" } })
    const html = await response.text()
    const at = (text: string) => html.indexOf(text)
    expect({
      failed: app.shellFailures.map(([route]) => route),
      status: response.status,
      fallbackInShell: at('<p id="cart-fallback">loading cart</p>') !== -1,
      framesAfterShell: at('id="nifra-ppr:greeting"') > at("</main>"),
      greeting: html.includes("hello ada"),
      cartProps: html.includes('"props":{"count":2}'),
      warnings: app.warnings,
    }).toEqual({
      failed: ["leaky/[id]"],
      status: 200,
      fallbackInShell: true,
      framesAfterShell: true,
      greeting: true,
      cartProps: true,
      warnings: [],
    })
  } finally {
    await app.stop()
  }
})

test("a data request's abort cancels the Preact app's slow hole", async () => {
  const app = await startPprApp()
  try {
    const started = probe.slowStarted
    const client = new AbortController()
    const response = await fetch(`${app.origin}/p/7?slow=60000`, {
      headers: { [DATA_HEADER]: "1" },
      signal: client.signal,
    })
    await response.body?.getReader().read()
    expect(probe.slowStarted).toBe(started + 1)
    const aborted = nextSlowAbort()
    client.abort()
    await aborted
  } finally {
    await app.stop()
  }
})
