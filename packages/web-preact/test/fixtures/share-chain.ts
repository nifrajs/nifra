/** The chain `share-browser.test.ts` renders on the server and mounts in the browser. */
import type { RenderProps } from "@nifrajs/web"
import { type ComponentChildren, h } from "preact"
import { memo } from "preact/compat"

type Row = { readonly id: number; readonly label: string }
type Counts = { layout: number; page: number; rows: number }
// The browser entry installs the counters; a server render counts into a throwaway.
const counts = (): Counts =>
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the browser entry is the only writer of this global
  (Reflect.get(globalThis, "shareCounts") as Counts | undefined) ?? { layout: 0, page: 0, rows: 0 }

export const Layout = (props: {
  readonly data: unknown
  readonly children?: ComponentChildren
}) => {
  counts().layout++
  return h("main", null, props.children)
}

// Memoized, as an app memoizes a row: a row the reload kept is skipped.
const RowView = memo((props: { readonly row: Row }) => {
  counts().rows++
  return h("li", { "data-id": props.row.id }, h("input", { type: "checkbox" }), props.row.label)
})

export const Page = (props: RenderProps) => {
  counts().page++
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the fixture's loader data is a list
  const { items } = props.data as { readonly items: readonly Row[] }
  return h(
    "ul",
    null,
    items.map((row) => h(RowView, { key: row.id, row })),
  )
}
