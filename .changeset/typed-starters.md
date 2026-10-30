---
"create-nifra": minor
---

Every starter links with `href()`: the navigation and the 404 page of the React, Preact, Solid, Svelte, Vue and ISR starters build their anchors with `href({ to })`, so a renamed route fails `tsc` instead of leaving a dead link. The generated `AGENTS.md` teaches `href()` and `rawHref()` for `navigate()`, `redirect()` and links, in place of `redirect(url)`.

Upgrade, for an existing app: `tsc` lists each `navigate("/x")`, `<Link to="/x">` and `redirect("/x")` (they take an `Href` now), and `href="/` and ``href={`/`` find the plain anchors it cannot see. A route file that imports no `./+types/...` module does not load `.nifra/types/routes.d.ts`; `nifra check` warns, and listing that file under the tsconfig `files` fixes it.
