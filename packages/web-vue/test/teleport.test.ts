import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { defer, renderPageResult } from "@nifrajs/web"
import { h, Teleport } from "vue"
import { vueAdapter } from "../src/index.ts"

const START = "<!--teleport start anchor-->"
const END = "<!--teleport anchor-->"

let warn: ReturnType<typeof spyOn<Console, "warn">>
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => warn.mockRestore())

const render = async (page: () => unknown, data: unknown = { n: 1 }) =>
  (
    await renderPageResult({
      adapter: vueAdapter,
      chain: [page],
      data,
      clientEntry: "/c.js",
      routeId: "index",
      title: "t",
    })
  )
    .toResponse()
    .text()

const teleport = (to: string, text: string) => h(Teleport, { to }, h("dialog", text))

test("a body teleport is the first content of <body>, where Vue hydrates it from", async () => {
  const html = await render(() => h("main", [teleport("body", "modal"), h("p", "page")]))
  expect(html).toContain(`<body>${START}<dialog>modal</dialog>${END}<div id="root">`)
  expect(warn).not.toHaveBeenCalled()
})

test("an #id target the app does not render gets its own container before the app root", async () => {
  const html = await render(() =>
    h("main", [teleport("#modals", "one"), teleport("body", "first"), teleport("#modals", "two")]),
  )
  expect(html).toContain(
    `<body>${START}<dialog>first</dialog>${END}<div id="modals">${START}<dialog>one</dialog>${END}${START}<dialog>two</dialog>${END}</div><div id="root">`,
  )
})

test("an empty #id target the app renders receives the content as its first children", async () => {
  const html = await render(() =>
    h("main", [
      h("aside", { class: "rail", id: "slot" }),
      h("p", { "data-id": "slot" }),
      teleport("#slot", "in"),
    ]),
  )
  expect(html).toContain(`<aside class="rail" id="slot">${START}<dialog>in</dialog>${END}</aside>`)
  expect(html).not.toContain(`<div id="slot">`)
})

test("a target that would hydrate against the wrong nodes renders on the client, with a warning", async () => {
  const html = await render(() =>
    h("main", [
      h("aside", { id: "busy" }, h("b", "own")),
      teleport("#busy", "x"),
      teleport(".cls", "y"),
    ]),
  )
  expect(html).toContain(`<aside id="busy"><b>own</b></aside>`)
  expect(html).not.toContain("<dialog>")
  expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
    `[nifra] <Teleport to="#busy"> renders on the client only: its target has children of its own.`,
    `[nifra] <Teleport to=".cls"> renders on the client only: on the server use "body" or "#id".`,
  ])
})

test("a page that defers data warns that its teleports render on the client", async () => {
  const html = await render(() => h("main", [teleport("body", "late")]), {
    slow: defer(Promise.resolve(1)),
  })
  expect(html).not.toContain("<dialog>late</dialog>")
  expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
    "[nifra] <Teleport> content renders on the client only on a page that defers data.",
  ])
})
