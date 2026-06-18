import { h, type VNode } from "preact"

export interface PageData {
  readonly items: ReadonlyArray<{ readonly id: number; readonly name: string }>
}

export function App(props: { data: PageData }): VNode {
  return h(
    "main",
    null,
    h("h1", null, `Items (${props.data.items.length})`),
    h(
      "ul",
      null,
      props.data.items.map((it) => h("li", { key: it.id }, it.name)),
    ),
  )
}
