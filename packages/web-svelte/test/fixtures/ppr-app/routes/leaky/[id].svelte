<script module>
  import Hole from "@nifrajs/web-svelte/hole"
  import { ui } from "@nifrajs/web-svelte/ppr"
  import Text from "../../frontend/Text.svelte"

  const note = {
    name: "note",
    mode: "dynamic",
    render: (data) => ui(Text, { id: "note", text: data.text }),
    fallback: ui(Text, { id: "note-fallback", text: "loading note" }),
  }

  export const boundaries = [note]
</script>

<script>
  let { data, boundaries: states } = $props()
</script>

<main>
  <h1 id="leaky">{data.who}</h1>
  <Hole of={note} state={states?.note} />
</main>
