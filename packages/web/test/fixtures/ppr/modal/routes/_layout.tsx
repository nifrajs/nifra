import type { ReactNode } from "react"

export default function Layout(props: { readonly children?: ReactNode }) {
  return (
    <div>
      <nav>
        <a id="to-other" href="/other">
          other
        </a>
      </nav>
      {/* WebKit paints a loading document only once it holds about 200 characters of text. */}
      <p>
        A small tea shop. Every order is packed by hand from loose leaf bought direct from the
        growers, weighed on the day it ships and sealed in a tin that keeps it fresh for a year. Ask
        about samples before you choose.
      </p>
      {props.children}
    </div>
  )
}
