import { expect, test } from "bun:test"
import { t } from "@nifrajs/schema"
import {
  clientIsland,
  defineClientIsland,
  nativeServerView,
} from "@nifrajs/web/server-components/islands"
import { h } from "preact"
import { useState } from "preact/hooks"
import { preactServerComponents } from "../src/server-components/server.ts"

test("Preact renders native server views and hook islands with projected public props", async () => {
  const counter = defineClientIsland(
    {
      props: t.object({ title: t.string() }),
      component: ({ title }: { title: string }) => {
        const [count] = useState(0)
        return h("article", null, h("h2", null, title), h("button", null, `Count ${count}`))
      },
    },
    "c_counter",
  )
  const publicProps = { title: "Public island", privateValue: "PRIVATE_ISLAND_SENTINEL" }
  const adapter = preactServerComponents()
  const result = await adapter.render(
    () =>
      nativeServerView(
        ({
          props: projected,
          islands,
        }: {
          props: { title: string }
          islands: { picker: { html: string } }
        }) =>
          h(
            "section",
            null,
            h("h1", null, projected.title),
            h("div", { dangerouslySetInnerHTML: { __html: islands.picker.html } }),
          ),
        { picker: clientIsland(counter, "stable", publicProps) },
      ),
    { title: "Public view" },
    { reference: "c_summary", instance: "i_summary", signal: new AbortController().signal },
  )
  expect(adapter.name).toBe("preact")
  expect(result.html).toContain("Public view")
  expect(result.html).toContain("Public island")
  expect(result.html).toContain("Count 0")
  expect(result.html).toContain("<nifra-island data-nifra-island=")
  expect(result.html).not.toContain("PRIVATE_ISLAND_SENTINEL")
  expect(result.islands).toHaveLength(1)
  expect(result.islands?.[0]?.props).toEqual({ title: "Public island" })
})
