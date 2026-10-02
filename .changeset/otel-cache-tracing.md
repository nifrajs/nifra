---
"@nifrajs/otel": minor
---

`cacheTracing()` from `@nifrajs/otel/cache` turns `@nifrajs/cache` operations into spans.

- Pass it as `createCache({ observer: cacheTracing({ exporter }) })`. Every operation on a view bound with `cache.for(c)` becomes a `cache <op>` child span of `c.trace`, with `nifra.cache.operation`, `nifra.cache.outcome` and `nifra.cache.tag_count`.
- Raw keys stay in the process. By default a span carries only the key prefix (`user:42` gives `nifra.cache.key_prefix = "user"`); `keyAttribute: "none"` drops it and a function exports its own value.
- The background refresh of a stale `wrap` is a `cache revalidate` span in its own trace, linked to the request span.
- `StartObservation.startTime` and `EndObservation.durationMs` record work after it settled.
