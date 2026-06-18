<!--
  Home route. `<script module>` exports loader/meta (server-only — tree-shaken from the client); the
  instance `<script>` + markup are the component. The view lives in <Counter> so editing it
  hot-swaps with state intact; this route file full-reloads on save (it exports loader/meta).
-->
<script module>
  export const meta = {
    title: "nifra — HMR (Svelte)",
    meta: [{ name: "description", content: "True HMR via @nifrajs/web/vite" }],
  }

  // Proves SSR still runs under the Vite dev server: this value is server-rendered into the document.
  export async function loader({ api }) {
    const res = await api.hello.get()
    return { message: res.data?.message ?? "" }
  }
</script>

<script>
  import Counter from "../components/Counter.svelte"

  let { data } = $props()
</script>

<Counter message={data.message} />
