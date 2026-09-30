---
"@nifrajs/web": minor
"@nifrajs/web-react": minor
---

feat(web): `data-nifra-prefetch` picks when a link warms its route: `intent`, `viewport`, `render` or `none`.

```html
<nav data-nifra-prefetch="viewport">
  <a href="/docs/routing">Routing</a>
  <a href="/reports/annual" data-nifra-prefetch="none">Annual report</a>
</nav>
```

The attribute goes on a link or on any element around it; the nearest one wins. `intent` (the
default, as before) warms the route's code and loader data on hover or keyboard focus, `viewport`
once the link scrolls into view, `render` as soon as a page shows it, and `none` never. An unknown
value is `intent`. `viewport` and `render` links are found when the page loads and whenever the
router settles (a navigation, a submit); a link the page adds in between warms on intent until
then. It works under every adapter, and React's `<Link>` and `<NavLink>` take a `prefetch` prop
that renders it.

Prefetched data is now used by a click within 30 seconds of arriving; after that the click loads
the route again. The page already on screen is no longer prefetched. `PrefetchMode` is exported
from `@nifrajs/web`.
