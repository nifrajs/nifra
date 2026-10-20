import { expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import { componentRangeHTML } from "../src/server-components/html.ts"
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
    '<iframe srcdoc="fixture"></iframe>',
    '<template><img onerror="fixture()"></template>',
  ])
    await expect(render(html)).rejects.toMatchObject({ code: "component_protocol" })
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
