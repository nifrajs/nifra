import type { ReactNode } from "react"

export default function UserLayout({ children }: { readonly children?: ReactNode }) {
  return <div id="user-layout">User layout{children}</div>
}
