import type { ReactNode } from "react"

export default function Layout(props: { children?: ReactNode }) {
  return (
    <div>
      <nav id="nav">
        <a href="/">home</a> · <a href="/users/7">user 7</a> · <a href="/about">about</a>
      </nav>
      {props.children}
    </div>
  )
}
