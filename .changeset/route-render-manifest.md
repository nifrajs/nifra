---
"@nifrajs/web": minor
"@nifrajs/cli": minor
---

`nifra routes --modes` — every route's render mode, hydration, and cache policy, gated against the target.

The facts were always in the route modules: `prerender`, `getStaticPaths`, `revalidate`, `hydrate`.
Nowhere read them together. Answering "which pages are static?", "which revalidate, how often?", "which
ship no JS?" meant opening every route file and holding the answer in your head - and the answer changes
with the deploy target, which is nowhere near the route file.

The new `@nifrajs/web/route-manifest` derives one record per route - static | isr | ssr, hydration, cache
policy - and resolves it against a target. `nifra routes --modes` prints the table; `--modes --target <t>`
gates: a route the target cannot honour exits non-zero, so CI fails the build instead of production
failing the request. The two cases that were previously silent are exactly the ones it catches: an ssr or
isr route in a `static` build (no server, so the URL 404s in production while working in dev), and ISR
where the target has no revalidation. Each conflict names the consequence, not the rule.

Two derivations are deliberate. `prerender` wins over `revalidate`, because a page rendered at build time
is not revalidated at runtime - the build-time answer is the one that ships. And a dynamic route counts as
static only once the build has actually emitted paths for it: `getStaticPaths` is the intent, the emitted
paths are the evidence, and treating intent as sufficient is how a "static" build ships a page that 404s.
Pass the paths `prerenderRoutes` produced via `buildRouteManifest`'s `prerendered` option to resolve those
routes against what was really built.
