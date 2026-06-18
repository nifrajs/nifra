import type { ReactNode } from "react"
export default function Layout(props: { children?: ReactNode }) {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 520, margin: "3rem auto" }}>
      <h1>nifra — i18n demo</h1>
      {props.children}
    </main>
  )
}
