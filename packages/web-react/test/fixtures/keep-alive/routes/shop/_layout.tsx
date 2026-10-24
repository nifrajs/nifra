import type { ReactNode } from "react"
import { useState } from "react"

export default function ShopLayout({ children }: { readonly children?: ReactNode }) {
  const [opened, setOpened] = useState(0)
  return (
    <div className="shop">
      <button type="button" className="shop-count" onClick={() => setOpened((n) => n + 1)}>
        shop {opened}
      </button>
      {children}
    </div>
  )
}
