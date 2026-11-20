---
"@nifrajs/web": minor
"@nifrajs/web-react": minor
---

`href()` and `rawHref()` no longer throw on a value that comes from data. A param that is missing, empty, `.`, `..` or an unpaired surrogate, a `hash` with an unpaired surrogate, a `search` key reserved for route-slot state, and a `rawHref` path that is not same-origin now log a `console.error` that names the route and the param, never the value, and return an inert `Href`. The default log writes each distinct message once, so a page of rows with the same bad param is one line. `onHrefRefused(report)` takes over: it hears every refusal, in place of the log, so an app can send them to its error tracker.

`Link`, `NavLink`, `Navigate`, `setSearchParams`, `navigate()` in every adapter, and a click on a plain `<a>` holding the inert value all do nothing, so one bad row costs its own link and not the render. Before hydration, or without scripts, a plain anchor holding it resolves to a path no route serves. `redirect()` throws a clear error for it, since there is nowhere to send the visitor, unless you pass `{ fallback: href({ to: "/" }) }`: an action that has already written should, so a bad value costs the destination and not a 500 after the write. A route that is not in the route table stays a compile error. Code that caught the `TypeError` from `href()` or `rawHref()` should check `isInertHref(result)` from `@nifrajs/web` instead.
