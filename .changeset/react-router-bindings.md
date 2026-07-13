---
"@nifrajs/web-react": minor
"@nifrajs/web": minor
---

Add first-class React routing bindings on the new `@nifrajs/web-react/router` subpath — `<Link>`,
`<NavLink>`, `useNavigate`, `useParams`, `useLocation`, `useSearchParams`, and `<Navigate>` — a
drop-in replacement for `react-router-dom`'s routing surface over nifra's own file-based router.

The read hooks are SSR-correct: `@nifrajs/web` now threads the matched route's `params` and the
request `path` (`pathname + search`) through the render seam (`RenderProps`), and the React adapter's
`compose` provides them via a `RouterContext` on both the server render and the client mount — so
`useParams`/`useLocation`/`useSearchParams` return the same value on each side with no hydration
mismatch. Programmatic navigation flows through a new DOM-free bridge (`getBrowserNavigate` /
`setBrowserNavigate`, populated by `installHistory`), which also gains history `replace` support, so a
route component reaches history-aware navigation without importing the browser-only client layer.
