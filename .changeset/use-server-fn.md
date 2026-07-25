---
"@nifrajs/web": minor
"@nifrajs/web-react": minor
"@nifrajs/web-preact": minor
"@nifrajs/web-solid": minor
"@nifrajs/web-vue": minor
"@nifrajs/web-svelte": minor
---

Add `useServerFn` - a server function's pending, data and error state - to all five adapters.

```tsx
const addTodo = useServerFn(fns.addTodo)
<button disabled={addTodo.pending} onClick={() => addTodo.call({ text }).catch(() => {})}>add</button>
```

Calling a server function never needed a binding: the client stub is `(input) => Promise<Output>`.
This adds only the state a component wants around it.

The state machine is `@nifrajs/web`'s `createServerFnStore`, shared by every adapter, so "is it
pending" has one answer rather than five that drift. Each binding contributes just its subscription
primitive: `useSyncExternalStore` (React, Preact), a signal (Solid), a `shallowRef` (Vue), a `readable`
(Svelte).

Two behaviours worth knowing:

- **The last call wins.** A response that is no longer the newest is discarded rather than written, so
  a slow first call landing after a fast second cannot overwrite fresh data with stale.
- **`call` still rejects.** The error is recorded for rendering AND the promise rejects, so `await`
  behaves normally. A caller that only renders from state should attach `.catch(() => {})`, as with
  `useFetcher`'s `submit`.

`data` is kept while the next call is in flight, so a rendered list does not blank on every refetch.
