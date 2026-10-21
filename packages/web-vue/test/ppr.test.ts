import { expect, spyOn, test } from "bun:test"
import { createSSRApp, defineComponent, h, Teleport, useId, useSSRContext } from "vue"
import { renderToString } from "vue/server-renderer"
import { vueAdapter } from "../src/index.ts"
import { Hole, type HoleDefinition, type HoleProps } from "../src/ppr.ts"

const asImport = (path: string): string => JSON.stringify(new URL(path, import.meta.url).href)
// A fresh Bun compiles the fixture's single-file components from cold.
const SPAWN_TIMEOUT_MS = 30_000

/**
 * Runs `code` in a fresh Bun and returns what it printed as JSON: the fixture registers Vue's SSR
 * plugin for the whole process, which this suite's process must not keep.
 */
async function inBun(code: string): Promise<unknown> {
  const proc = Bun.spawn([process.execPath, "--eval", code], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(stderr).toBe("")
  expect(exit).toBe(0)
  return JSON.parse(stdout)
}

const Field = defineComponent({
  props: { label: { type: String, required: true } },
  setup(props) {
    const id = useId()
    return () => h("span", null, [h("label", { for: id }, props.label), h("input", { id })])
  },
})

test("a hole's fragment renders inside renderFragment, its ids under the hole's own prefix", async () => {
  const renderFragment = vueAdapter.renderFragment?.bind(vueAdapter)
  let rendering = false
  const html = await renderFragment?.(
    () => {
      rendering = true
      return h(Field, { label: "qty" })
    },
    { idPrefix: "nifra-cart-" },
  )
  expect(rendering).toBe(true)
  expect(html).toBe('<span><label for="nifra-cart--0">qty</label><input id="nifra-cart--0"></span>')
  // One VNode, rendered twice, as a definition's fallback is for every request.
  const fallback = h(Field, { label: "wait" })
  const twice = await Promise.all([
    renderFragment?.(() => fallback, {}),
    renderFragment?.(() => fallback, {}),
  ])
  expect(twice).toEqual([
    '<span><label for="v-0">wait</label><input id="v-0"></span>',
    '<span><label for="v-0">wait</label><input id="v-0"></span>',
  ])
})

test("a hole that is not a lone component renders under its prefix too", async () => {
  const render = (ui: () => unknown) => vueAdapter.renderFragment?.(ui, { idPrefix: "nifra-box-" })
  const Box = defineComponent({
    setup:
      (_, { slots }) =>
      () =>
        h("div", slots.default?.()),
  })
  const field = '<span><label for="nifra-box--0">a</label><input id="nifra-box--0"></span>'
  expect(await render(() => h("p", [h(Field, { label: "a" })]))).toBe(`<p>${field}</p>`)
  expect(await render(() => h(Box, null, { default: () => h(Field, { label: "a" }) }))).toBe(
    `<div>${field}</div>`,
  )
  expect(await render(() => "text")).toBe("text")
})

test("concurrent renders under one prefix each read their own SSR context", async () => {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>()
  const Count = defineComponent({
    setup() {
      const context = useSSRContext<{ count?: number }>()
      if (context === undefined) throw new Error("no SSR context")
      context.count = (context.count ?? 0) + 1
      return () => h("i", String(context.count))
    },
  })
  // Count's setup runs after the gate, once both renders have provided their contexts.
  const Slow = defineComponent({
    async setup() {
      await gate
      return () => h(Count)
    },
  })
  const renders = [0, 1].map(() =>
    vueAdapter.renderFragment?.(() => h(Slow), { idPrefix: "nifra-slow-" }),
  )
  release()
  expect(await Promise.all(renders)).toEqual(["<i>1</i>", "<i>1</i>"])
})

test("a hole's teleport renders on the client only, with a dev warning", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  try {
    const html = await vueAdapter.renderFragment?.(
      () => h("div", [h(Teleport, { to: "body" }, h("p", "x"))]),
      {},
    )
    expect(html).toBe("<div><!--teleport start--><!--teleport end--></div>")
    expect(warn).toHaveBeenCalledWith(
      "[nifra] <Teleport> content in a partially prerendered hole renders on the client only.",
    )
  } finally {
    warn.mockRestore()
  }
})

test("Hole renders an empty host for a shell, and the boundary's own states otherwise", async () => {
  const of: HoleDefinition<{ readonly n: number }> = {
    name: "cart",
    render: (data) => h("p", null, `ready ${data.n}`),
    fallback: h("p", null, "waiting"),
  }
  const body = async (state: HoleProps<{ readonly n: number }>["state"]) =>
    (
      await renderToString(
        createSSRApp({
          render: () => h(Hole, { of, state }, { error: () => h("p", null, "failed") }),
        }),
      )
    ).replace(/<!--[^>]*-->/g, "")
  expect({
    shell: await body({ status: "pending", ppr: true }),
    unrendered: await body(undefined),
    ready: await body({ status: "ready", data: { n: 1 } }),
    failed: await body({ status: "error" }),
    streamedEmpty: await body({ status: "pending" }),
    streamedValue: await body({ status: "pending", data: { n: 2 } }),
  }).toEqual({
    shell: '<div data-nifra-hole="cart" aria-busy="true"></div>',
    unrendered: "<p>waiting</p>",
    ready: "<p>ready 1</p>",
    failed: "<p>failed</p>",
    streamedEmpty: "<p>waiting</p>",
    streamedValue: "<p>ready 2</p>",
  })
})

test(
  "the Vue PPR app serves a checked shell and fills its holes after it",
  async () => {
    const out = await inBun(`
      const { startPprApp } = await import(${asImport("./fixtures/ppr-app/server.ts")});
      const app = await startPprApp();
      try {
        const response = await fetch(app.origin + "/p/1", { headers: { cookie: "name=ada" } });
        const html = await response.text();
        const at = (text) => html.indexOf(text);
        console.log(JSON.stringify({
          failed: app.shellFailures.map(([route]) => route),
          status: response.status,
          fallbackInShell: at('<p id="cart-fallback">loading cart</p>') !== -1,
          framesAfterShell: at('id="nifra-ppr:greeting"') > at("</main>"),
          greeting: html.includes("hello ada"),
          cartProps: html.includes('"props":{"count":2}'),
          warnings: app.warnings,
        }));
      } finally {
        await app.stop();
      }
    `)
    expect(out).toEqual({
      failed: ["leaky/[id]"],
      status: 200,
      fallbackInShell: true,
      framesAfterShell: true,
      greeting: true,
      cartProps: true,
      warnings: [],
    })
  },
  SPAWN_TIMEOUT_MS,
)
