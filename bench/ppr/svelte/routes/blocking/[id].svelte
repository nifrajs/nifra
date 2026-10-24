<script>
  import Cart from "../../frontend/Cart.svelte"
  import Greeting from "../../frontend/Greeting.svelte"
  import ProductPage from "../../frontend/ProductPage.svelte"
  import Recs from "../../frontend/Recs.svelte"

  let { data } = $props()
</script>

<ProductPage product={data.product}>
  <Greeting name={data.greeting.name} />
  <Cart count={data.cart.count} />
  <Recs items={data.recs.items} />
</ProductPage>
