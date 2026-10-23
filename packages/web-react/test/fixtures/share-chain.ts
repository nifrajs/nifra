/** The chain `share-browser.test.ts` renders on the server and mounts in the browser. */
import type { RenderProps } from "@nifrajs/web"
import { createElement, memo, type ReactNode } from "react"

type Row = { readonly id: number; readonly label: string }
type Counts = { layout: number; page: number; rows: number }
// The browser entry installs the counters; a server render counts into a throwaway.
const counts = (): Counts =>
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the browser entry is the only writer of this global
  (Reflect.get(globalThis, "shareCounts") as Counts | undefined) ?? { layout: 0, page: 0, rows: 0 }

export const Layout = (props: { readonly data: unknown; readonly children?: ReactNode }) => {
  counts().layout++
  return createElement("main", null, props.children)
}

// Memoized, as an app memoizes a row: a row the reload kept is skipped.
const RowView = memo((props: { readonly row: Row }) => {
  counts().rows++
  return createElement(
    "li",
    { "data-id": props.row.id },
    createElement("input", { type: "checkbox" }),
    props.row.label,
  )
})

export const Page = (props: RenderProps) => {
  counts().page++
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the fixture's loader data is a list
  const { items } = props.data as { readonly items: readonly Row[] }
  return createElement(
    "ul",
    null,
    items.map((row) => createElement(RowView, { key: row.id, row })),
  )
}
