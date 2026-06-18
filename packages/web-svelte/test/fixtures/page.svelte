<!--
  A route SFC fixture for the compiler plugin. `<script module>` carries nifra's server-only named
  exports (loader/meta); the instance `<script>` + markup is the component. The scoped <style>
  exercises the CSS pipeline: the dom build extracts it to a virtual ?svelte-css module (Svelte scopes
  `#title` → `#title.svelte-<hash>` and bakes the class into the markup); the ssr build emits no CSS.
-->
<script module>
  export const meta = { title: "Svelte route" }
  export function loader() {
    return { greeting: "hello from the svelte loader" }
  }
</script>

<script>
  let { data } = $props()
</script>

<h1 id="title">{data.greeting}</h1>

<style>
  #title {
    color: rebeccapurple;
  }
</style>
