---
"@nifrajs/web": minor
"@nifrajs/otel": minor
"@nifrajs/skills": minor
"@nifrajs/cli": minor
---

Give the failures the framework throws a stable code, a cause and a fix that `nifra explain` and the dev overlay return. The new codes cover components, partial prerendering, deployment output, live, route files, route configuration, the typed wire, storage keys, OpenAPI import, assurance and effect declarations, tools, content, jobs, i18n, schemas, build output and plugins, assets, CSP, CDN adapters, headers and cookies, WebSockets, cron, GraphQL, images, and the production traps: an in-memory store in production, `cors` credentials with a wildcard origin, a short secret, and middleware installed out of order.

A validation message counts as nifra's own only when the error was thrown from inside an installed `@nifrajs` package, so an app's own error with similar wording keeps its own handling.

Record React, Vue, Svelte, Preact and Solid development warnings in the dev feed under `NIFRA_REACT_WARNING`, `NIFRA_VUE_WARNING`, `NIFRA_SVELTE_DIAGNOSTIC`, `NIFRA_PREACT_DIAGNOSTIC` and `NIFRA_SOLID_DIAGNOSTIC`. A warning is listed with a warning mark and does not make `nifra errors` exit 1; Solid's error-severity codes and Preact's thrown errors still do.

Export an error's stable code as the `nifra.error.code` span attribute, for nifra's own error classes and codes.

Add the `nifra-errors` skill: every stable error and `nifra check` code with its cause and repair, generated from the same catalogs.
