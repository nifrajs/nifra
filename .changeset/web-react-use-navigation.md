---
"@nifrajs/web-react": minor
"@nifrajs/web": minor
---

Navigation loading UI for `@nifrajs/web-react/router`, plus a per-link pending signal.

nifra navigates imperatively - it fetches the next route's chunk and loader data while the current route stays on screen, then swaps - so a route transition is signalled by the router's `pending` flag, not a Suspense boundary.

- `useNavigation()` returns `{ pending, state: "idle" | "loading", location }` (Remix-shaped); `location` is the `pathname + search` being navigated to while pending. `usePending()` is the boolean form.
- `NavLink`'s render-prop `isPending` is now real: it is `true` while a navigation to that link's own target is in flight (matched like `isActive`), so a link can show its own spinner. Previously always `false`.
- The agnostic router now publishes `pendingPath` (the navigation target) on its state while `pending`, and `compose` threads `pending`/`pendingPath` into the router context. Both are `false`/absent on the server and the initial client render, so they are hydration-safe.
