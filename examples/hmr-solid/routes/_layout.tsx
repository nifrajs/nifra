import type { JSX } from "solid-js"

/** Root layout — wraps every page; the nav proves the layout renders on each route. */
export default function Layout(props: { children?: JSX.Element }) {
  return (
    <div>
      <nav id="nav">
        <a href="/">home</a> · <a href="/about">about</a>
      </nav>
      {props.children}
    </div>
  )
}
