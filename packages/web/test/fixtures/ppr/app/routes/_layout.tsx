import type { ReactNode } from "react"

export default function Layout(props: { readonly children?: ReactNode }) {
  return (
    <div>
      <nav>
        <a id="to-home" href="/">
          home
        </a>{" "}
        <a id="to-p1" href="/p/1">
          p1
        </a>{" "}
        <a id="to-p2" href="/p/2">
          p2
        </a>{" "}
        <a id="to-other" href="/other">
          other
        </a>
      </nav>
      {props.children}
    </div>
  )
}
