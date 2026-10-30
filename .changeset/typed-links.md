---
"@nifrajs/web": minor
"@nifrajs/web-react": minor
---

`redirect()` takes an `Href` (from `href()` or `rawHref()`), and any other string needs `{ external: true }`, so `redirect("/login")`, a template literal and a string variable are compile errors. React's `Link`, `NavLink` and `Navigate` take `to: Href`. `Link` and `NavLink` render the anchor without an `href` (and log a `console.error`) when `to` is not a same-origin path, instead of writing it into the anchor's `href`; a link to another site is a plain `<a href>`.

Upgrade: `redirect("/login")` becomes `redirect(href({ to: "/login" }))`, `<Link to="/pricing">` becomes `<Link to={href({ to: "/pricing" })}>`, and a path built elsewhere is `rawHref(path)` in either. `redirect(url, { external: true })` is unchanged.
