/**
 * Browser entry for `share-browser.test.ts`: a list page mounted by `mountRouter`, each row a `<For>`
 * entry holding a checkbox. `?share=0` opts the route out of structural sharing.
 */
import { createClientRouter } from "@nifrajs/web/client"
import { createComponent, createEffect, For } from "solid-js"
import { insert } from "solid-js/web"
import { listData } from "../../../web/test/share-browser.ts"
import { mountRouter } from "../../src/client.ts"

type Row = { readonly id: number; readonly label: string }
type List = { readonly items: readonly Row[] }

const counts = { rows: 0, effects: 0 }
let labels: Record<number, string> = {}

const Page = (props: { readonly data: List }) => {
  createEffect(() => {
    void props.data
    counts.effects++
  })
  const list = document.createElement("ul")
  insert(
    list,
    createComponent(For<readonly Row[], HTMLLIElement>, {
      get each() {
        return props.data.items
      },
      children: (row) => {
        counts.rows++
        const item = document.createElement("li")
        item.dataset.id = String(row.id)
        const box = document.createElement("input")
        box.type = "checkbox"
        item.append(box, row.label)
        return item
      },
    }),
  )
  return list
}

const router = createClientRouter({
  patterns: [{ routeId: "list", pattern: "/list" }],
  initial: { routeId: "list", params: {}, path: "/list", data: listData(), pending: false },
  routeHooks:
    new URLSearchParams(location.search).get("share") === "0" ? { list: { shareData: false } } : {},
  fetchData: async () => listData(labels),
})
// The action's POST; the revalidation that follows goes through `fetchData`.
window.fetch = Object.assign(async () => Response.json({ ok: true }), fetch)
// No server render: `hydrate` falls back to a client render once Solid's handover says it is done.
Reflect.set(globalThis, "_$HY", {
  done: true,
  events: [],
  completed: new WeakSet(),
  r: {},
  fe() {},
})
const root = document.getElementById("root")
mountRouter({ router, routes: { list: [Page] }, container: root })

const rowAt = (id: number) => root?.querySelector<HTMLLIElement>(`li[data-id="${id}"]`)
let held: HTMLLIElement[] = []
Reflect.set(globalThis, "fixture", {
  counts,
  submit: () => router.submit("/list", new URLSearchParams()),
  relabel: (next: Record<number, string>) => {
    labels = next
  },
  tick: (id: number) => rowAt(id)?.querySelector("input")?.click(),
  ticked: (id: number) => rowAt(id)?.querySelector("input")?.checked === true,
  hold: () => {
    held = [...(root?.querySelectorAll("li") ?? [])]
  },
  // Which rows are no longer the element they were when `hold` ran.
  replaced: () =>
    [...(root?.querySelectorAll("li") ?? [])].flatMap((item, i) =>
      item === held[i] ? [] : [Number(item.dataset.id)],
    ),
  label: (id: number) => rowAt(id)?.textContent,
  ready: true,
})
