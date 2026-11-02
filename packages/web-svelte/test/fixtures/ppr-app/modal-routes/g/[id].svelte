<script module>
  import { closeBoundary } from "@nifrajs/web/client"
  import Hole from "@nifrajs/web-svelte/hole"
  import { ui } from "@nifrajs/web-svelte/ppr"
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
  const photo = { name: "photo", mode: { intercept: "/photo/:id" } }

  export const boundaries = [greeting, cart, photo]
</script>

<script>
  let { data, boundaries: states } = $props()
</script>

<main>
  <h1 id="title">{data.title}</h1>
  <input id="probe" />
  <Hole of={greeting} state={states?.greeting} />
  <Hole of={cart} state={states?.cart} />
  <a id="to-photo-7" href="/photo/7">photo 7</a>{" "}
  <a id="to-photo-8" href="/photo/8">photo 8</a>
  {#if states?.photo?.status === "ready"}
    <dialog open data-nifra-boundary="photo">
      <h2 id="modal-title">{states.photo.data.title}</h2>
      <button id="close" type="button" onclick={() => closeBoundary("photo")}>close</button>
    </dialog>
  {/if}
</main>
