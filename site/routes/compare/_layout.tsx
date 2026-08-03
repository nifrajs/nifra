import type { ReactNode } from "react"

// Comparison pages are prose articles: root layout chrome, narrow measure, no docs sidebar.
export default function CompareLayout(props: { children: ReactNode }) {
  return (
    <div style={{ maxWidth: 760, margin: "48px auto", padding: "0 4px" }}>{props.children}</div>
  )
}
