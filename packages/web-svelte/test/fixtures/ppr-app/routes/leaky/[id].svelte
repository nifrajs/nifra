<script module>
  import { ui } from "../../../../../src/ppr.ts"
  import Text from "../../frontend/Text.svelte"

  export const boundaries = [
    {
      name: "note",
      mode: "dynamic",
      render: (data) => ui(Text, { id: "note", text: data.text }),
      fallback: ui(Text, { id: "note-fallback", text: "loading note" }),
    },
  ]
</script>

<script>
  let { data } = $props()
</script>

<h1 id="leaky">{data.who}</h1>
