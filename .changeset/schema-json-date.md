---
"@nifrajs/schema": minor
"@nifrajs/web": minor
---

`t.date()` and `t.json()` for page data. A `loaderOutput` or `actionOutput` field declared `t.date()` reaches the page as a `Date` in the server render, on hydration, on client navigations, in streamed `t.deferred` values and in server function results; a `Date` or an ISO date string is accepted, anything else fails the route by path. `t.json()` declares a field that is any JSON value and passes it through whole. `JsonValue` is exported from `@nifrajs/schema`.
