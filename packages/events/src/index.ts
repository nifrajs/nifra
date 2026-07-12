/**
 * @nifrajs/events — portable, versioned event contracts.
 *
 * Define the *shape* of an event once (a typed, versioned envelope validated by any Standard Schema),
 * then produce validated envelopes and parse untrusted input against them at any boundary. Delivery
 * is deliberately out of scope — a contract is transport-agnostic, so the same event shape flows
 * through SSE, a queue, a webhook, or a durable outbox relay unchanged.
 */

export {
  defineEventContract,
  type EventContract,
  EventContractError,
  type EventEnvelope,
  type EventParseResult,
} from "./contract.ts"
export {
  createEventRegistry,
  type EventRegistry,
  type RegistryParseResult,
} from "./registry.ts"
