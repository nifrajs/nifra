import { expect, test } from "bun:test"
import { unlinkSync } from "node:fs"
import { assertRenderAdapterConformance } from "@nifrajs/web"
import { createComponent, createResource, Suspense } from "solid-js"
import { solidAdapter, solidBunPlugin } from "../src/index.ts"

test("solidAdapter conforms to the executable RenderAdapter interface", async () => {
  const layout = (marker: string) => (props: { children: unknown }) => [marker, props.children]
  const Page = (props: { data: unknown; pending?: boolean }) => [
    "PAGE",
    (props.data as { name: string }).name,
    `PENDING:${String(props.pending)}`,
  ]
  await assertRenderAdapterConformance(solidAdapter, {
    page: Page,
    outerLayout: layout("OUTER"),
    innerLayout: layout("INNER"),
    props: { data: { name: "conformance-data" }, pending: true },
    markers: {
      page: "PAGE",
      data: "conformance-data",
      pending: "PENDING:true",
      outer: "OUTER",
      inner: "INNER",
    },
  })
})

// SSR side runs under bun (server build of solid-js/web). Full hydration interactivity is
// browser-verified against the real packages (see the example) — bun:test has no DOM.

test("renderToStream streams a Suspense boundary: fallback bytes precede the resolved content", async () => {
  // No JSX — `createComponent` is what the Solid transform emits; lets this run under bun:test.
  const Slow = () => {
    const [r] = createResource(
      () => new Promise<string>((res) => setTimeout(() => res("RESOLVED"), 30)),
    )
    return r()
  }
  const App = () =>
    createComponent(Suspense, {
      get fallback() {
        return "FALLBACK"
      },
      get children() {
        return createComponent(Slow, {})
      },
    })
  const stream = await solidAdapter.renderToStream([App], { data: null })
  const html = await new Response(stream).text()
  expect(html).toContain("RESOLVED") // the resolved content streamed in
  expect(html.indexOf("FALLBACK")).toBeLessThan(html.indexOf("RESOLVED")) // fallback streamed first
})

test("hydrationHead returns Solid's hydration bootstrap (the _$HY registry)", () => {
  const head = solidAdapter.hydrationHead()
  expect(head.length).toBeGreaterThan(0)
  expect(head).toContain("_$HY")
})

test("solidBunPlugin compiles a .tsx through Solid's Babel transform", async () => {
  const plugin = solidBunPlugin("dom")
  type OnLoad = (args: { path: string }) => Promise<{ contents: string; loader: string }>
  let onLoad: OnLoad | undefined
  const builder = {
    onLoad: (_filter: unknown, cb: OnLoad) => {
      onLoad = cb
    },
  }
  // Minimal PluginBuilder stub — the test only exercises the registered onLoad callback.
  plugin.setup(builder as unknown as Parameters<typeof plugin.setup>[0])
  expect(plugin.name).toBe("nifra-solid-dom")
  expect(onLoad).toBeDefined()

  const fixture = `${import.meta.dir}/__solid_fixture.tsx`
  await Bun.write(fixture, "export const C = (p: { n: number }) => <div>{p.n}</div>\n")
  try {
    const out = await (onLoad as OnLoad)({ path: fixture })
    expect(out.loader).toBe("js")
    expect(out.contents).toContain("_$template") // JSX compiled into a Solid template call
    expect(out.contents).toContain("solid-js/web") // pulls in Solid's DOM runtime
    expect(out.contents).not.toContain("{p.n}") // the JSX expression was compiled, not left raw
  } finally {
    unlinkSync(fixture)
  }
})

test("solidBunPlugin names itself per generate mode", () => {
  expect(solidBunPlugin("ssr").name).toBe("nifra-solid-ssr")
  expect(solidBunPlugin("dom").name).toBe("nifra-solid-dom")
})
