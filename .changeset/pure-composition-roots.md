---
"create-nifra": minor
---

Every template composes its routes from feature modules, and the effect provenance firewall ships ARMED.

`provenance.imports` now maps the database drivers and the `--db` seam, so a route that can reach a
database without declaring it fails `nifra check`. Combined with the `authenticated-write` rule, the
whole chain holds without anyone remembering anything:

- a route that writes and declares nothing fails the check;
- declare it, and the route fails assurance until it is authenticated;
- only an authenticated write ships.

Arming it required the app root to stop registering routes. Reach is computed from the module that
REGISTERS a route, following that module's imports, so a root that both composes and registers hands
every route in it the reach of everything merged there - and a GET route may not declare a domain write
at all, leaving those routes with no legal declaration and no fix but to move. So `src/app.ts` (api,
fullstack) and `backend.ts` (site, isr) merge and nothing else; the demo routes moved to `src/routes.ts`,
`src/notes.ts`, `counter.ts` and `page.ts` beside them. Exports are unchanged - `app`, `backend`, `queue`
and `wasIndexed` are all still imported from where they were.

That is the shape a feature should take anyway: a module owns its store, its adapters and the routes
over them, and a second feature with a database of its own gets its own file rather than a section.
