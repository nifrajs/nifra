import { expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import type { ComponentRecord } from "@nifrajs/web/server-components"
import {
  clientIsland,
  defineClientIsland,
  nativeServerView,
  serverComponentChild,
} from "@nifrajs/web/server-components/islands"
import { h } from "preact"
import { useState } from "preact/hooks"
import { preactAdapter } from "../src/index.ts"
import { preactServerComponents } from "../src/server-components/server.ts"

test("Preact renders native server views and hook islands with projected public props", async () => {
  const ordinary = preactAdapter.renderToString
  if (ordinary === undefined) throw new Error("Ordinary Preact SSR must remain available")
  const Page = () => h("p", null, "Ordinary SSR")
  expect(await ordinary([Page], { data: {} })).toBe("<p>Ordinary SSR</p>")
  const counter = defineClientIsland(
    {
      props: t.object({ title: t.string() }),
      slots: ["summary"],
      component: ({ title, slots }: { title: string; slots?: Record<string, string> }) => {
        const [count] = useState(0)
        return h(
          "article",
          null,
          h("h2", null, title),
          h("button", null, `Count ${count}`),
          h("div", { dangerouslySetInnerHTML: { __html: slots?.summary ?? "" } }),
        )
      },
    },
    "c_counter",
  )
  const publicProps = { title: "Public island", privateValue: "PRIVATE_ISLAND_SENTINEL" }
  const child: ComponentRecord = {
    instance: "i_detail",
    reference: "c_detail",
    key: "detail",
    parent: "i_summary",
    input: {},
    html: "<p>Public nested range</p>",
  }
  const selected = serverComponentChild([child], { reference: "c_detail" }, "detail")
  const adapter = preactServerComponents()
  const result = await adapter.render(
    () =>
      nativeServerView(
        ({
          props: projected,
          islands,
          ranges,
        }: {
          props: { title: string }
          islands: { picker: { html: string } }
          ranges: { detail: { html: string } }
        }) =>
          h(
            "section",
            null,
            h("h1", null, projected.title),
            h("div", { dangerouslySetInnerHTML: { __html: islands.picker.html } }),
            h("div", { dangerouslySetInnerHTML: { __html: ranges.detail.html } }),
          ),
        { picker: clientIsland(counter, "stable", publicProps, { summary: "<p>Public slot</p>" }) },
        { detail: selected },
      ),
    { title: "Public view" },
    {
      reference: "c_summary",
      instance: "i_summary",
      signal: new AbortController().signal,
      children: [child],
    },
  )
  expect(adapter.name).toBe("preact")
  expect(result.html).toContain("Public view")
  expect(result.html).toContain("Public island")
  expect(result.html).toContain("Count 0")
  expect(result.html).toContain(
    '<nifra-slot data-nifra-slot="summary"><p>Public slot</p></nifra-slot>',
  )
  expect(result.html).toContain(
    '<nifra-component data-nifra-component="i_detail"><p>Public nested range</p></nifra-component>',
  )
  expect(result.html).toContain("<nifra-island data-nifra-island=")
  expect(result.html).not.toContain("PRIVATE_ISLAND_SENTINEL")
  expect(result.islands).toHaveLength(1)
  expect(result.islands?.[0]?.props).toEqual({ title: "Public island" })
  const warm = ordinary([Page], { data: {} })
  expect(warm).not.toBeInstanceOf(Promise)
  expect(warm).toBe("<p>Ordinary SSR</p>")
})

test("Preact rejects invalid native contracts and foreign child ownership", async () => {
  const adapter = preactServerComponents()
  const context = {
    reference: "c_summary",
    instance: "i_summary",
    signal: new AbortController().signal,
  }
  await expect(adapter.render(() => "unregistered view", {}, context)).rejects.toThrow(
    "component_contract",
  )
  expect(() =>
    defineClientIsland({
      props: t.object({}),
      component: () => h("p", null),
      slots: ["constructor"],
    }),
  ).toThrow("component_contract")
  expect(() => serverComponentChild([], { reference: "c_foreign" }, "detail")).toThrow(
    "component_contract",
  )
  const foreign: ComponentRecord = {
    instance: "i_foreign",
    reference: "c_detail",
    key: "detail",
    parent: "i_other",
    input: {},
    html: "<p>Foreign</p>",
  }
  await expect(
    adapter.render(
      () => nativeServerView(() => h("p", null), {}, { detail: foreign }),
      {},
      { ...context, children: [foreign] },
    ),
  ).rejects.toThrow("component_contract")
})
