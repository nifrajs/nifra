/**
 * Spans for `@nifrajs/cache` operations. `cacheTracing()` returns the cache's `observer`: every operation
 * on a view bound with `cache.for(c)` becomes a child span of `c.trace` (or of `JobContext.trace` inside
 * a traced job). Raw keys never leave the process unless you say so with `keyAttribute`.
 *
 *   import { cacheTracing } from "@nifrajs/otel/cache"
 *   const cache = createCache({ observer: cacheTracing({ exporter }) })
 *   await cache.for(c).wrap(`user:${id}`, load)   // span "cache wrap", nifra.cache.key_prefix = "user"
 */

import { traceOfContext } from "./context-trace.ts"
import { createObservationLifecycle } from "./lifecycle.ts"
import type { AttributeValue, ObservationAdapter } from "./span.ts"

/** The `CacheEvent` of `@nifrajs/cache`, declared structurally so this package does not depend on it. */
export interface CacheTracingEvent {
  readonly op: string
  readonly outcome: string
  readonly startedAt: number
  readonly durationMs: number
  readonly key: string | undefined
  readonly tag: string | undefined
  readonly tagCount: number
  readonly context: object | undefined
}

/**
 * What of a key (or an invalidated tag) a span carries:
 * - `"prefix"` (default): the leading token before the first `:`, exported as `nifra.cache.key_prefix`
 *   only when it matches `^[a-z][a-z0-9_-]{0,31}$` - `user:42` gives `user`, a key with no `:` gives
 *   nothing;
 * - `"none"`: nothing;
 * - a function: its result is exported as `nifra.cache.key` (return `undefined` to omit). It runs on
 *   raw keys, so it owns the redaction.
 */
export type CacheKeyAttribute = "prefix" | "none" | ((key: string) => string | undefined)

export interface CacheTracingOptions {
  readonly exporter?: ObservationAdapter
  readonly adapters?: readonly ObservationAdapter[]
  readonly keyAttribute?: CacheKeyAttribute
}

/** Pass as `createCache({ observer })`. */
export type CacheTracingObserver = (event: CacheTracingEvent) => void

const KEY_PREFIX = /^[a-z][a-z0-9_-]{0,31}$/

function keyPrefix(key: string): string | undefined {
  const end = key.indexOf(":")
  if (end < 1 || end > 32) return undefined
  const prefix = key.slice(0, end)
  return KEY_PREFIX.test(prefix) ? prefix : undefined
}

/**
 * Spans for cache operations on views bound with `for(context)`. A bound operation becomes a child of
 * the context's trace; an operation on the unbound cache, or under a context with no trace, is not
 * traced. A stale `wrap` that starts a background refresh gets a separate `cache revalidate` span in its
 * own trace, LINKED to the request span: the refresh outlives the request, so it is not its child.
 */
export function cacheTracing(options: CacheTracingOptions = {}): CacheTracingObserver {
  const adapters = [
    ...(options.exporter === undefined ? [] : [options.exporter]),
    ...(options.adapters ?? []),
  ]
  const lifecycle = createObservationLifecycle({ adapters })
  const keyAttribute = options.keyAttribute ?? "prefix"

  const keyAttributes = (
    attributes: Record<string, AttributeValue>,
    value: string,
    prefixName: string,
    fullName: string,
  ): void => {
    if (keyAttribute === "none") return
    if (keyAttribute === "prefix") {
      const prefix = keyPrefix(value)
      if (prefix !== undefined) attributes[prefixName] = prefix
      return
    }
    try {
      const exported = keyAttribute(value)
      if (typeof exported === "string") attributes[fullName] = exported
    } catch {
      // A throwing key mapper drops the attribute, never the span.
    }
  }

  return (event) => {
    const trace = traceOfContext(event.context)
    if (trace === null) return
    const attributes: Record<string, AttributeValue> = {
      "nifra.cache.operation": event.op,
      "nifra.cache.outcome": event.outcome,
      "nifra.cache.tag_count": event.tagCount,
    }
    if (event.key !== undefined)
      keyAttributes(attributes, event.key, "nifra.cache.key_prefix", "nifra.cache.key")
    if (event.tag !== undefined)
      keyAttributes(attributes, event.tag, "nifra.cache.tag_prefix", "nifra.cache.tag")
    const revalidation = event.op === "revalidate"
    lifecycle
      .start({
        name: `cache ${event.op}`,
        kind: "internal",
        startTime: event.startedAt,
        attributes,
        ...(revalidation
          ? { parent: null, links: [{ traceId: trace.traceId, spanId: trace.spanId }] }
          : { parent: trace }),
      })
      .end({ status: event.outcome === "error" ? "error" : "ok", durationMs: event.durationMs })
  }
}
