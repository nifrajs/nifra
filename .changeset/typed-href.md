---
"@nifrajs/web": minor
"@nifrajs/core": minor
"@nifrajs/web-react": minor
"@nifrajs/web-preact": minor
"@nifrajs/web-solid": minor
"@nifrajs/web-svelte": minor
"@nifrajs/web-vue": minor
---

`href({ to, params, search, hash })` builds an in-app URL from a route pattern and returns an `Href`; `rawHref(path)` returns one for a same-origin path built elsewhere (a CMS link, `/llms.txt`). `to` is a key of the generated `RouteTable`, so a misspelt route, a missing, misspelt or extra param, and a `search` that breaks the route's schema are compile errors. A route without a `searchSchema` takes any `search`. Each param is encoded as one path segment, so a value such as `a/b` or `//evil.com` cannot change where the URL goes; a param that is missing, empty, `.`, `..` or an unpaired surrogate throws a `TypeError` naming it and the pattern. `rawHref` throws a `TypeError` unless `isSameOriginPath` accepts the path. Both are exported by `@nifrajs/web` and by the `/router` entry of every adapter.

`navigate` takes an `Href` or a history delta. A string, a template literal and the `{ to, search }` object form are compile errors, and a value forged past the types is still held to the same-origin check the browser navigate makes. `<Navigate to>` and the `useSearchParams` setter in `@nifrajs/web-react` pass their path through `rawHref`, so an off-origin `to` throws instead of doing nothing. `isSameOriginPath` is exported from `@nifrajs/core/pattern` as well as `@nifrajs/core/server`.

Upgrade: `navigate("/users/7")` becomes `navigate(href({ to: "/users/:id", params: { id: "7" } }))`, `navigate({ to, search, replace: true })` becomes `navigate(href({ to, search }), { replace: true })`, and a path built elsewhere is `navigate(rawHref(path))`. `resolveNavigate`, `NavigateTargetInput` and `NavigateSearchOf` are removed from `@nifrajs/web`.
