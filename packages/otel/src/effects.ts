/** Token-only OpenTelemetry spans for capability admission, execution, compensation, and reconciliation. */

import type { EffectLifecycleEvent, EffectLifecycleObserver } from "@nifrajs/core/effect-lifecycle"
import type { AnyServer, IdentityPlugin } from "@nifrajs/core/server"
import { type ActiveObservation, createObservationLifecycle } from "./lifecycle.ts"
import type { AttributeValue, ObservationAdapter } from "./span.ts"

export interface EffectTracingOptions {
  readonly exporter?: ObservationAdapter
  readonly adapters?: readonly ObservationAdapter[]
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
  const lifecycle = createObservationLifecycle({ adapters })
  const active = new Map<string, ActiveObservation>()
  const keyOf = (event: EffectLifecycleEvent): string => `${event.effectId}\n${event.stage}`

  const observer: EffectLifecycleObserver = (event) => {
    const key = keyOf(event)
    if (event.phase === "started") {
      if (active.has(key)) return
      active.set(
        key,
        lifecycle.start({
          name: `nifra.effect.${event.stage}`,
          parent: event.trace ?? null,
          attributes: attributesOf(event),
        }),
      )
      return
    }
    let observation = active.get(key)
    if (observation === undefined) {
      observation = lifecycle.start({
        name: `nifra.effect.${event.stage}`,
        parent: event.trace ?? null,
        attributes: attributesOf(event),
      })
    } else {
      active.delete(key)
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
