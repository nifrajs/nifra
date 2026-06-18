/** @jsxImportSource preact */
import type { ComponentChildren } from "preact"

/** Root layout — wraps every page; the nav proves the layout renders on each route. */
export default function Layout(props: { children?: ComponentChildren }) {
  return (
    <div>
      <nav id="nav">
        <a href="/">home</a> · <a href="/about">about</a>
      </nav>
      {props.children}
    </div>
  )
}
