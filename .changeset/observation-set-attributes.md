---
"@nifrajs/otel": minor
---

`ActiveObservation.setAttributes(attributes)` — merge attributes onto the in-flight request span from a handler or later plugin (`c.observation.setAttributes({ "tenant.key": ... })`), for facts learned mid-request (authenticated principal, flag bucket, cache verdict). Silently a no-op once the observation has ended; the exported span stays immutable.
