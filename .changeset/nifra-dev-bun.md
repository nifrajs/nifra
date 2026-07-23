---
"@nifrajs/cli": minor
---

`nifra dev --bun` — the Bun pipeline is now selectable in dev, completing the pipeline matrix.

`nifra build --vite` already let an app choose its production bundler, but dev was Vite-only from the
CLI: the Bun dev server existed solely as a library entry (`@nifrajs/web/dev`), so using it meant
hand-writing a `dev.ts`. `nifra dev --bun` runs it directly - `Bun.serve`'s native HMR bundles and
hot-reloads the client while Bun's runtime resolves SSR, with no Vite in the process. Both pipelines are
now selectable in both phases, and neither ever runs inside the other.

It refuses one case rather than breaking quietly. Bun's DEV-server bundler and `Bun.build` are not the
same bundler: `Bun.build` compiles `*.module.css` into a scoped class map (so the Bun production build of
a CSS-Modules app is fine), but the dev server's bundler has no such transform - the import becomes a
dangling reference and the browser throws `ReferenceError: import_X_module is not defined` from inside the
component, naming neither CSS Modules nor the dev server. So `--bun` checks for CSS Modules up front and
refuses with the offending files named and both ways forward. The check is deliberately narrow: only the
transform proven missing is refused, so an app without CSS Modules gets the Bun dev loop.

Bun applies React Fast Refresh natively on this path — verified: editing a component-only module swaps its
markup while a `useState` counter keeps its value, with no reload. The boundary rule is the same one Vite
has (a route file that also exports `loader`/`meta` is not a refresh boundary, so saving it reloads). Plain
CSS and Tailwind work; only `*.module.css` is refused.

Default is unchanged - `nifra dev` stays Vite, for its plugin ecosystem.
