---
"@nifrajs/middleware": minor
"@nifrajs/core": minor
"@nifrajs/otel": patch
---

`logger()` logs the matched route template as `path` (`/share/:token`, never `/share/9f2c...`), so
ids and tokens a URL carries stay out of request logs. A request no route matched logs its pathname;
`rawPath: true` logs the pathname always. The query string is never logged.

`routeTemplateOf(app)` is exported from `@nifrajs/core/server` for any plugin that labels requests by
route; `@nifrajs/otel` tracing now uses it.
