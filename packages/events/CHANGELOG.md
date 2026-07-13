# @nifrajs/events

## 1.10.0

## 1.9.1

## 1.9.0

## 1.8.0

### Minor Changes

- 513b005: Add `@nifrajs/events`: portable, versioned event contracts. `defineEventContract({ type, version, payload })`
  builds a typed, transport-agnostic envelope (`id`/`type`/`version`/`occurredAt`/`payload`) validated by any
  Standard Schema; `create` stamps and validates outgoing events, `parse`/`is` validate untrusted input at a
  boundary, and `createEventRegistry` dispatches mixed input to the right contract by `type@version` (failing
  closed on an unknown contract). Delivery is intentionally out of scope — the same event shape flows through
  SSE, a queue, a webhook, or a durable outbox relay unchanged.
