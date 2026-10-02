---
"@nifrajs/otel": minor
---

`traceEventConsumer()` from `@nifrajs/otel/events` traces an `@nifrajs/events` consumer with one wrapper.

- `traceEventConsumer(contractOrRegistry, handler, { exporter })` returns `consume(input, parent?)`. Each envelope is one `process <type>` consumer span, linked to the producer's span through `causalitySpanLink(envelope.causality)`; with a `parent` trace (a webhook route's `c.trace`) the span is its child.
- Attributes: `nifra.event.type`, `nifra.event.version`, `messaging.message.id` (the envelope id), `messaging.operation.type`/`.name` = `process`, and `messaging.system` (`system` option, default `"nifra.events"`).
- Input that fails to parse never reaches the handler: it resolves `{ success: false, issueCount }` and records an error span carrying the issue count and, for a registry, its bounded reason. No payload is exported.
- The handler receives `{ trace }` for nested spans, and `scope` runs it inside an ambient context.
