import type { ReactNode } from "react"

/** A React layout — wraps the page via `props.children`. Composed by the chain in server.ts. */
export default function Layout(props: { children?: ReactNode }) {
  return (
    <div className="app">
      <nav id="nav">nifra · react · F2.1 layout</nav>
      {props.children}
    </div>
  )
}
