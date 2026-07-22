/** Token-only OpenTelemetry spans for capability admission, execution, compensation, and reconciliation. */

import type { EffectLifecycleEvent, EffectLifecycleObserver } from "@nifrajs/core/effect-lifecycle"
import type { AnyServer, IdentityPlugin } from "@nifrajs/core/server"
import { type ActiveObservation, createObservationLifecycle } from "./lifecycle.ts"
import type { AttributeValue, ObservationAdapter } from "./span.ts"

export interface EffectTracingOptions {
  readonly exporter?: ObservationAdapter
  readonly adapters?: readonly ObservationAdapter[]
  /** Maximum unmatched started events retained at once. Default 10,000. */
  readonly maxActive?: number
  /** Opportunistically expire unmatched events older than this many milliseconds. Default 5 min. */
  readonly maxActiveAgeMs?: number
  /** Injectable wall clock for deterministic retention tests. */
  readonly now?: () => number
}

export interface EffectTracingPlugin extends IdentityPlugin {
  /** Pass the same observer to `createSagaEngine({ observer })` and reconciliation helpers. */
  readonly observer: EffectLifecycleObserver
}

function attributesOf(event: EffectLifecycleEvent): Record<string, AttributeValue> {
  const attributes: Record<string, AttributeValue> = {
    "nifra.effect.id": event.effectId,
    "nifra.effect.capability": event.capability,
    "nifra.effect.stage": event.stage,
    "nifra.effect.phase": event.phase,
  }
  if (event.target !== undefined) attributes["nifra.effect.target"] = event.target
  if (event.digest !== undefined) attributes["nifra.effect.digest"] = event.digest
  if (event.attempt !== undefined) attributes["nifra.effect.attempt"] = event.attempt
  if (event.errorCode !== undefined) attributes["nifra.effect.error_code"] = event.errorCode
  if (event.durationMs !== undefined) attributes["nifra.effect.duration_ms"] = event.durationMs
  for (const [axis, value] of Object.entries(event.cost ?? {})) {
    attributes[`nifra.effect.cost.${axis}`] = value
  }
  return attributes
}

/**
 * Installs child effect spans on subsequent routes. The observer consumes only the constrained
 * `EffectLifecycleEvent` contract; request/business payloads and error text cannot enter an export.
 */
export function effectTracing(options: EffectTracingOptions = {}): EffectTracingPlugin {
  const adapters = [
    ...(options.exporter === undefined ? [] : [options.exporter]),
    ...(options.adapters ?? []),
  ]
  const maxActive = options.maxActive ?? 10_000
  const maxActiveAgeMs = options.maxActiveAgeMs ?? 5 * 60_000
  if (!Number.isSafeInteger(maxActive) || maxActive < 1) {
    throw new RangeError("effect tracing maxActive must be a positive safe integer")
  }
  if (!Number.isSafeInteger(maxActiveAgeMs) || maxActiveAgeMs < 1) {
    throw new RangeError("effect tracing maxActiveAgeMs must be a positive safe integer")
  }
  const now = options.now ?? Date.now
  const lifecycle = createObservationLifecycle({ adapters })
  const active = new Map<string, { readonly observation: ActiveObservation; readonly at: number }>()
  let nextSweepAt = Number.POSITIVE_INFINITY
  const keyOf = (event: EffectLifecycleEvent): string => `${event.effectId}\n${event.stage}`

  const evict = (key: string, errorCode: "observation_evicted" | "observation_expired"): void => {
    const entry = active.get(key)
    if (entry === undefined) return
    active.delete(key)
    entry.observation.setAttributes({
      "nifra.effect.phase": "ambiguous",
      "nifra.effect.error_code": errorCode,
    })
    entry.observation.end({ status: "error" })
  }

  const sweep = (): number => {
    const at = now()
    if (!Number.isFinite(at) || at < nextSweepAt) return at
    // `active` iterates in insertion order and entries carry a monotonic `at`, so the front is the
    // oldest / earliest-expiring. Evict the expired prefix and stop at the first live entry: its expiry
    // is the earliest remaining, i.e. the next sweep deadline. A sweep is therefore O(evicted), not
    // O(active.size). (A backwards clock only defers an eviction to the size cap - the hard bound; age
    // eviction is opportunistic.)
    nextSweepAt = Number.POSITIVE_INFINITY
    for (const [key, entry] of active) {
      const expiresAt = entry.at + maxActiveAgeMs
      if (at >= expiresAt) {
        evict(key, "observation_expired")
      } else {
        nextSweepAt = expiresAt
        break
      }
    }
    return at
  }

  const observer: EffectLifecycleObserver = (event) => {
    const at = sweep()
    const key = keyOf(event)
    if (event.phase === "started") {
      if (active.has(key)) return
      while (active.size >= maxActive) {
        const oldest = active.keys().next().value as string | undefined
        if (oldest === undefined) break
        evict(oldest, "observation_evicted")
      }
      const startedAt = Number.isFinite(at) ? at : event.at
      active.set(
        key,
        Object.freeze({
          observation: lifecycle.start({
            name: `nifra.effect.${event.stage}`,
            parent: event.trace ?? null,
            attributes: attributesOf(event),
          }),
          at: startedAt,
        }),
      )
      nextSweepAt = Math.min(nextSweepAt, startedAt + maxActiveAgeMs)
      return
    }
    const entry = active.get(key)
    let observation: ActiveObservation
    if (entry === undefined) {
      observation = lifecycle.start({
        name: `nifra.effect.${event.stage}`,
        parent: event.trace ?? null,
        attributes: attributesOf(event),
      })
    } else {
      active.delete(key)
      observation = entry.observation
      observation.setAttributes(attributesOf(event))
    }
    observation.end({ status: event.phase === "succeeded" ? "ok" : "error" })
  }

  const apply = <S extends AnyServer>(app: S): S => {
    app.observeCapability(observer)
    return app
  }
  return Object.assign(apply, {
    pluginName: "nifra:effect-tracing",
    observer,
  }) as EffectTracingPlugin
}
