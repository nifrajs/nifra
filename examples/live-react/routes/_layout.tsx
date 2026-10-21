import type { ReactNode } from "react"

/** Root layout: page chrome inside the document shell. */
export default function Layout(props: { children?: ReactNode }) {
  return (
    <main>
      <h1>nifra - live refresh demo</h1>
      {props.children}
    </main>
  )
}
