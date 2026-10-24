import { createSignal, type JSX } from "solid-js"

export default function ShopLayout(props: { readonly children?: JSX.Element }) {
  const [opened, setOpened] = createSignal(0)
  return (
    <div class="shop">
      <button type="button" class="shop-count" onClick={() => setOpened((n) => n + 1)}>
        shop {opened()}
      </button>
      {props.children}
    </div>
  )
}
