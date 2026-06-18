import type { ReactNode } from "react"

/** Root layout — wraps every page; the nav drives client-side navigation on the edge. */
export default function Layout(props: { children?: ReactNode }) {
  return (
    <div>
      <nav id="nav">
        <a href="/">home</a> · <a href="/users/7">user 7</a> · <a href="/about">about</a> ·{" "}
        <a href="/slow">streaming</a>
      </nav>
      {props.children}
    </div>
  )
}
