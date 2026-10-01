<!--
  Home route. `<script module>` exports meta (the loader lives in index.backend.ts); the instance
  `<script>` + markup are the component. The view lives in <Counter> so editing it hot-swaps with
  state intact; this route file full-reloads on save (it exports meta).
-->
<script module>
  export const meta = {
    title: "nifra - HMR (Svelte)",
    meta: [{ name: "description", content: "True HMR via @nifrajs/web/vite" }],
  }
</script>

<script>
  import Counter from "../frontend/components/Counter.svelte"

  let { data } = $props()
</script>

<Counter message={data.message} />
