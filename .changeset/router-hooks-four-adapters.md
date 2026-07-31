---
"@nifrajs/web-preact": minor
"@nifrajs/web-vue": minor
"@nifrajs/web-solid": minor
"@nifrajs/web-svelte": minor
---

Preact, Vue, Solid and Svelte gain `useNavigate` and `useBlocker`, from `@nifrajs/web-<framework>/router`.

`useNavigate` returns a programmatic navigate (a path pushes or replaces; a number is a history delta),
matching the React adapter. `useBlocker` is the unsaved-changes guard - pass a boolean or a
`({ currentLocation, nextLocation }) => boolean` predicate and get back a `{ state, proceed, reset }`
value in each framework's own reactive shape (a Vue ref, a Solid accessor, a Svelte store, a plain value
in Preact). When a navigation is intercepted, `state` becomes `"blocked"`; show your own confirmation and
call `proceed()` or `reset()`. It also arms the native "Leave site?" prompt on tab close and reload.

```svelte
<script>
  import { useBlocker } from "@nifrajs/web-svelte/router"
  let dirty = false
  const blocker = useBlocker(() => dirty)
</script>

{#if $blocker.state === "blocked"}
  <dialog open>
    <button on:click={$blocker.reset}>Keep editing</button>
    <button on:click={$blocker.proceed}>Discard</button>
  </dialog>
{/if}
```

In Vue, Solid and Svelte the hook is created once, so pass a function to track a changing flag
(`useBlocker(() => dirty)`); a bare boolean is captured as-is. The guarding itself already ran on every
adapter at the browser layer - this exposes it as a reactive hook.
