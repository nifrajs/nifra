<script module>
  import Hole from "../../../../../src/Hole.svelte"
  import { ui } from "../../../../../src/ppr.ts"
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
  <h1 id="member">member {data.id}</h1>
  <Hole of={note} state={states?.note} />
</main>
