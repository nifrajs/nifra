<script>
  import Await from "@nifrajs/web-svelte/await"
  import Cart from "../../frontend/Cart.svelte"
  import Greeting from "../../frontend/Greeting.svelte"
  import Loading from "../../frontend/Loading.svelte"
  import ProductPage from "../../frontend/ProductPage.svelte"
  import Recs from "../../frontend/Recs.svelte"

  let { data } = $props()
</script>

<ProductPage product={data.product}>
  <Await resolve={data.greeting}>
    {#snippet pending()}<Loading text="loading greeting" />{/snippet}
    {#snippet children(value)}<Greeting name={value.name} />{/snippet}
  </Await>
  <Await resolve={data.cart}>
    {#snippet pending()}<Loading text="loading cart" />{/snippet}
    {#snippet children(value)}<Cart count={value.count} />{/snippet}
  </Await>
  <Await resolve={data.recs}>
    {#snippet pending()}<Loading text="loading recommendations" />{/snippet}
    {#snippet children(value)}<Recs items={value.items} />{/snippet}
  </Await>
</ProductPage>
