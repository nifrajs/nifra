---
"@nifrajs/schema": minor
"@nifrajs/web": minor
"@nifrajs/cache": patch
"@nifrajs/otel": minor
"@nifrajs/cli": patch
---

Add build-time schema compilation that emits typed static validators without runtime code generation. Generated modules preserve strict validation and structured issues while avoiding the schema builder and dynamic compiler in deployed bundles.

A schema whose property key, `format` name or custom kind holds a quote, backslash or line break, or whose literal holds a backslash or line break, now validates on the eval-free checker and is refused by build-time compilation. TypeBox splices that text into generated source unescaped, so a quote could end the string and run the rest as code.

Prepare immutable route modules and layout chains in production while executing authorization gates and loaders for every request. Mutable manifests can disable module preparation with `cacheRouteModules: false`.

Reduce output projection bookkeeping for uniform subtrees, reuse request-bound cache views, and record completed cache spans without allocating an active observation. Span parentage, sampling, redaction, exporter isolation, and capability enforcement remain intact.

Keep custom start-only `ObservationLifecycle` implementations compatible. The factory returns the extended `RecordingObservationLifecycle` interface with the new `record` method.

Mark the migration parser's TypeScript keyword-kind comparison as syntax, so the security check does not mistake it for a secret comparison.
