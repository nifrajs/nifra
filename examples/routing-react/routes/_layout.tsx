import "./app.css" // global stylesheet → bundled + content-hashed by buildClient, linked into <head>
import type { ReactNode } from "react"

/** Root layout — wraps every page; the nav proves the layout renders on each route. */
export default function Layout(props: { children?: ReactNode }) {
  return (
    <div>
      <nav id="nav">
        <a href="/">home</a> · <a href="/users/7">user 7</a> · <a href="/slow">streaming</a> ·{" "}
        <a href="/todos">todos</a>
      </nav>
      {props.children}
    </div>
  )
}
