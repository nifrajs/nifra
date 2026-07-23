# @nifrajs/events

## 2.1.0

## 2.0.0

### Patch Changes

- ade0c7a: Add a curated `@nifrajs/core/server` entry for the common HTTP runtime and dedicated subpaths for
  contracts, classification, cookies, logging, routing, Standard Schema, SEO, SSE, and webhooks. The
  package root remains backwards compatible, while new scaffolds and first-party runtime packages avoid
  eagerly parsing opt-in causality, invariant, manifest, reflection, capability, and assurance tooling.
- Updated dependencies [a7b1d60]
- Updated dependencies [eaac3d7]
- Updated dependencies [ade0c7a]
- Updated dependencies [82676e0]
- Updated dependencies [1522d06]
- Updated dependencies [a7b1d60]
- Updated dependencies [a7b1d60]
  - @nifrajs/core@2.0.0

## 1.13.0

## 1.12.0

### Minor Changes

- 63d3845: Add bounded execution-causality contracts and propagation, OpenTelemetry causal links, event-envelope lineage, and a deterministic durable failure laboratory. `nifra levels` L4 now uses the deep adversarial contract engine through its explicitly isolated executor. Also add hash-verifiable adapter certification profiles and duplicate physical Nifra/React install detection in `nifra doctor`/`nifra check`.

## 1.11.0

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
