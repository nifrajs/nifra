<script module>
  import Hole from "@nifrajs/web-svelte/hole"
  import { ui } from "@nifrajs/web-svelte/ppr"
  import Text from "../../frontend/Text.svelte"

  const price = {
    name: "price",
    mode: "shared",
    render: (data) => ui(Text, { id: "price", text: `price ${data.amount}` }),
    fallback: ui(Text, { id: "price-fallback", text: "loading price" }),
  }
  const greeting = {
    name: "greeting",
    mode: "dynamic",
    render: (data) => ui(Text, { id: "greeting", text: `hello ${data.name}` }),
    fallback: ui(Text, { id: "greeting-fallback", text: "loading greeting" }),
  }

  export const boundaries = [price, greeting]
</script>

<script>
  let { data, boundaries: states } = $props()
</script>

<main>
  <h1 id="title">{data.title}</h1>
  <Hole of={price} state={states?.price} />
  <Hole of={greeting} state={states?.greeting} />
  <a id="to-s9" href="/s/9">next</a>
</main>
