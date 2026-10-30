---
"@nifrajs/web-react": patch
"@nifrajs/web": patch
---

A destination that is not a same-origin path costs only its own link: `Link` and `NavLink` render the anchor without an `href`, `Navigate` and `setSearchParams` do not navigate, and each logs a `console.error` instead of throwing. `rawHref` still throws a `TypeError`.
