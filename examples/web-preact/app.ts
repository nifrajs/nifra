import { h, type VNode } from "preact"
import { useState } from "preact/hooks"

export interface PageData {
  message: string
  start: number
}

// A Preact route component (render function — no JSX, so no build plugin needed). `data` is the
// loader output; the useState counter proves hydration (it's interactive only after the client
// hydrates).
export function App(props: { data: PageData }): VNode {
  const [count, setCount] = useState(props.data.start)
  return h(
    "main",
    null,
    h("h1", null, props.data.message),
    h(
      "button",
      { id: "btn", type: "button", onClick: () => setCount((c) => c + 1) },
      `count: ${count}`,
    ),
  )
}
