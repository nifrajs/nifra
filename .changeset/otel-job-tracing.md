---
"@nifrajs/otel": minor
---

`jobTracing()` from `@nifrajs/otel/jobs` traces `@nifrajs/jobs` with OpenTelemetry messaging spans.

- Pass it as `createQueue({ instrument: jobTracing({ exporter }) })`.
- Each enqueue is a `send <job>` producer span (a child of `c.trace` when enqueued through `job.for(c)`), and its context is stored with the job.
- Each attempt is a `process <job>` consumer span: a child of the send span, plus a link to it. Retries are separate spans; a failed attempt is an error span, and the one that dead-letters the job carries `nifra.job.dead_lettered = true`.
- Attributes: `messaging.system = "nifra.jobs"`, `messaging.operation.type`, `messaging.operation.name`, `messaging.destination.name`, `messaging.message.id`, `nifra.job.attempt`, `nifra.job.outcome`. Error text is never exported.
- A malformed stored traceparent starts a new trace; the sampled flag travels with a valid one.
- `scope` runs each attempt inside an ambient context, such as the OpenTelemetry SDK's.
