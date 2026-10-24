<script module>
  import Hole from "@nifrajs/web-svelte/hole"
  import { ui } from "@nifrajs/web-svelte/ppr"
  import Cart from "../../frontend/Cart.svelte"
  import Greeting from "../../frontend/Greeting.svelte"
  import Loading from "../../frontend/Loading.svelte"
  import ProductPage from "../../frontend/ProductPage.svelte"
  import Recs from "../../frontend/Recs.svelte"

  const greeting = {
    name: "greeting",
    mode: "dynamic",
    render: (data) => ui(Greeting, { name: data.name }),
    fallback: ui(Loading, { text: "loading greeting" }),
  }
  const cart = {
    name: "cart",
    mode: "dynamic",
    interactive: true,
    render: (data) => ui(Cart, { count: data.count }),
    fallback: ui(Loading, { text: "loading cart" }),
  }
  const recs = {
    name: "recs",
    mode: "dynamic",
    render: (data) => ui(Recs, { items: data.items }),
    fallback: ui(Loading, { text: "loading recommendations" }),
  }
  export const boundaries = [greeting, cart, recs]
</script>

<script>
  let { data, boundaries: states } = $props()
</script>

<ProductPage product={data.product}>
  <Hole of={greeting} state={states?.greeting} />
  <Hole of={cart} state={states?.cart} />
  <Hole of={recs} state={states?.recs} />
</ProductPage>
