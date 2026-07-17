---
"@nifrajs/web-react": minor
---

Add `useNavigation()` and `usePending()` to `@nifrajs/web-react/router` for navigation loading UI.

nifra navigates imperatively - it fetches the next route's chunk and loader data while the current route stays on screen, then swaps - so a route transition is signalled by the router's `pending` flag, not a Suspense boundary. These hooks surface that flag (previously carried on the router state but not exposed to components) so a layout can render a top-bar spinner, dim content, or show a skeleton during a transition:

```tsx
const { pending } = useNavigation() // { pending, state: "idle" | "loading" }, Remix-shaped
```

`compose` now threads the `pending` flag into the router context alongside `params`/`path`. It is `false` on the server (loaders block before render) and on the initial client render, so it is hydration-safe. `usePending()` is the boolean convenience form.
