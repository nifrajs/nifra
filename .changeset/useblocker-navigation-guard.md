---
"@nifrajs/web": minor
"@nifrajs/web-react": minor
---

Guard navigation away from unsaved work with `useBlocker`.

Mirrors react-router's shape: pass a boolean or a `({ currentLocation, nextLocation }) => boolean`
predicate and get back `{ state, proceed, reset }`. When a navigation is intercepted - a `<Link>` or
anchor click, `useNavigate`, or a browser back/forward - `state` becomes `"blocked"`, so you render
your OWN confirmation and call `proceed()` to continue or `reset()` to stay. A plain boolean can't
express an async "are you sure?"; these two callbacks can.

```tsx
import { useBlocker } from "@nifrajs/web-react/router"

const blocker = useBlocker(form.isDirty)

return blocker.state === "blocked" ? (
  <ConfirmDialog onConfirm={blocker.proceed} onCancel={blocker.reset} />
) : null
```

Back and forward are guarded too: the destination URL is restored before you are asked, so the page
never changes underneath the prompt. It also arms the browser's native "Leave site?" prompt on tab
close and reload. Idle on the server and before hydration, so it degrades to native navigation and
stays hydration-safe.
