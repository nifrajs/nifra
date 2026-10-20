<script module>
  import Hole from "../../../../../src/Hole.svelte"
  import { ui } from "../../../../../src/ppr.ts"
  import Cart from "../../frontend/Cart.svelte"
  import Text from "../../frontend/Text.svelte"

  const greeting = {
    name: "greeting",
    mode: "dynamic",
    render: (data) => ui(Text, { id: "greeting", text: `hello ${data.name}` }),
    fallback: ui(Text, { id: "greeting-fallback", text: "loading greeting" }),
  }
  const cart = {
    name: "cart",
    mode: "dynamic",
    interactive: true,
    render: (data) => ui(Cart, { count: data.count }),
    fallback: ui(Text, { id: "cart-fallback", text: "loading cart" }),
  }
  const slow = {
    name: "slow",
    mode: "dynamic",
    render: (data) => ui(Text, { id: "slow", text: `slow ${data.at}` }),
    fallback: ui(Text, { id: "slow-fallback", text: "loading slow" }),
  }

  export const boundaries = [greeting, cart, slow]

  export const meta = (args) => ({
    link: [{ rel: "canonical", href: `${args.origin}/p/${args.params.id}` }],
  })
</script>

<script>
  let { data, boundaries: states } = $props()
</script>

<main>
  <h1 id="title">{data.title}</h1>
  <Hole of={greeting} state={states?.greeting} />
  <Hole of={cart} state={states?.cart} />
  <Hole of={slow} state={states?.slow} />
</main>
