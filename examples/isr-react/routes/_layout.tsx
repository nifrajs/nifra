import type { ReactNode } from "react"

/** Root layout — rendered inside the document shell `renderPage` emits (the `<html>`/`<head>`/`<body>`
 * and the `#root` container). Just page chrome here. */
export default function Layout(props: { children?: ReactNode }) {
  return (
    <main>
      <h1>nifra — ISR demo</h1>
      {props.children}
    </main>
  )
}
