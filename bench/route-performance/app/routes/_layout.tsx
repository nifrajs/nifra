/** @jsxImportSource preact */
import type { ComponentChildren } from "preact"

export default function Layout(props: {
  data: { workspace: string }
  children: ComponentChildren
}) {
  return (
    <>
      <header>{props.data.workspace}</header>
      {props.children}
    </>
  )
}
