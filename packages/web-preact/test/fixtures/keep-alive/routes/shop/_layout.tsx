/** @jsxImportSource preact */
import type { ComponentChildren } from "preact"
import { useState } from "preact/hooks"

export default function ShopLayout({ children }: { readonly children?: ComponentChildren }) {
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
