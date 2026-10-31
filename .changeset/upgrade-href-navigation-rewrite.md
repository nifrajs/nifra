---
"@nifrajs/cli": minor
---

The 5.10 upgrade wraps a string path given to `navigate()`, `redirect()` and React's `Link`, `NavLink` and `Navigate` in `rawHref(path)`, which sends the request the string did, and imports `rawHref` beside the name the file already takes from `@nifrajs/web` or an adapter's `/router` entry. A destination built from a template literal or a concatenation, a `navigate({ to })` object, and a path `rawHref` refuses are listed by their line in the rewritten file. `.vue` and `.svelte` templates are left for `tsc`.
