import { expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { componentRangeHTML, validateComponentHTML } from "../src/server-components/html.ts"
import {
  createServerComponents,
  defineServerComponent,
  serverComponentInstance,
} from "../src/server-components.ts"

async function render(html: string) {
  const component = defineServerComponent(
    {
      input: t.object({}),
      props: t.object({}),
      authorize() {},
      load: () => ({}),
      view: () => null,
    },
    "html_fixture",
  )
  const runtime = createServerComponents({
    build: "html_build",
    adapter: { name: "vue", version: 1, render: () => ({ html }) },
    owners: {
      page: {
        scope: "anonymous",
        components: [component],
        instances: () => [serverComponentInstance(component, "stable", {})],
      },
    },
  })
  const request = new Request("https://fixture.test/page")
  return runtime.execute("page", {
    request,
    req: request,
    params: {},
    api: undefined,
    env: undefined,
    draft: false,
    live() {},
    search: {},
    set: { headers: {}, cookie() {}, deleteCookie() {} },
    signal: request.signal,
    data: null,
    layoutData: [],
  })
}

test("initial server component output rejects executable managed HTML before document rendering", async () => {
  await expect(
    render("<nifra-slot><script>globalThis.fixture = 1</script></nifra-slot>"),
  ).rejects.toMatchObject({ code: "component_protocol" })
})

test("HTML policy rejects encoded URL/CSS execution and foreign parser-context escapes", async () => {
  for (const html of [
    '<svg><a xlink:href="java&#x73;cript:fixture()">x</a></svg>',
    '<table><tr><td><img src=x onerror="fixture()"></td></tr></table>',
    '<div style="background:url(j\\61vascript:fixture())">x</div>',
    '<div style="background:url(jav/**/ascript:fixture())">x</div>',
    '<svg><animate attributeName="href" values="javascript:fixture()" /></svg>',
    '<img srcset="data:image/svg+xml,fixture">',
    '<img srcset="/a.png 1x, javascript:fixture() 2x">',
    '<img srcset="/a.png, javascript:fixture() 2x">',
    '<img srcset="/a.png 1x,data:image/svg+xml,fixture 2x">',
    '<img srcset="/a.png,,&#x01;javascript:fixture()">',
    '<picture><source srcset="/a.avif (x, y) 1x, vbscript:fixture"></picture>',
    '<iframe srcdoc="fixture"></iframe>',
    '<template><img onerror="fixture()"></template>',
  ])
    await expect(render(html)).rejects.toMatchObject({ code: "component_protocol" })
})

test("a responsive image passes: each srcset candidate is held to the src rule", async () => {
  const html =
    '<picture><source srcset="/a.avif 1x, /a@2x.avif 2x" type="image/avif"><img src="/a.png" srcset="/a.png?w=100,200 100w, https://cdn.test/a.png 200w" sizes="(min-width: 40em) 50vw, 100vw" alt="a"></picture>'
  expect((await render(html)).records[0]?.html).toBe(html)
})

test("safe fragments, keyed table/SVG roots, styles and Unicode pass the SSR policy", async () => {
  const html =
    '<p style="color:blue">α😀</p><table><tbody><tr><td>public</td></tr></tbody></table><svg><circle cx="1" /></svg><!--native-marker-->'
  expect((await render(html)).records[0]?.html).toBe(html)
})

test("only compiler-listed hints are removed using complete token spans", () => {
  const assets = new Set(["/assets/entry-hash.js"])
  expect(
    componentRangeHTML(
      '<link rel="modulepreload" href="/assets/entry-hash.js" crossorigin=\'><img onerror="fixture()">\'><p>public</p>',
      assets,
    ),
  ).toBe("<p>public</p>")
  expect(() =>
    componentRangeHTML('<link rel="modulepreload" href="https://foreign.test/entry.js">', assets),
  ).toThrow()
})

test("React's image preload hints are cut from the range; a malformed one is refused", () => {
  const assets = new Set(["/assets/entry-hash.js"])
  expect(
    componentRangeHTML(
      '<link rel="preload" as="image" href="/a.png"/><link rel="preload" as="image" imageSrcSet="/b.png 1x, /b2.png 2x" imageSizes="50vw"/><section><img src="/a.png" alt=""/><img src="/b.png" srcSet="/b.png 1x, /b2.png 2x" alt=""/></section>',
      assets,
    ),
  ).toBe(
    '<section><img src="/a.png" alt=""/><img src="/b.png" srcSet="/b.png 1x, /b2.png 2x" alt=""/></section>',
  )
  for (const hint of [
    '<link rel="preload" as="image" href="javascript:fixture()"/>',
    '<link rel="preload" as="image" imageSrcSet="/b.png 1x, data:image/svg+xml,x 2x"/>',
    '<link rel="preload" as="image" href="/a.png" onload="fixture()"/>',
    '<link rel="preload" as="style" href="/a.css"/>',
  ])
    expect(() => componentRangeHTML(`${hint}<p>public</p>`, assets)).toThrow()
  // Outside a range, where no hint is cut, a link is still refused.
  expect(() => validateComponentHTML('<link rel="preload" as="image" href="/a.png"/>')).toThrow()
})
