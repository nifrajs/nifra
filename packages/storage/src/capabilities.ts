/**
 * Capability beacons for a storage adapter.
 *
 * `StorageAdapter` is meant to be implemented outside this package - that is the point of the
 * interface - so a `for(context)` METHOD on it would break every adapter anyone has written. This is a
 * wrapper instead: it takes any adapter and hands back one that announces what it is doing.
 *
 *   import { useCapability } from "@nifrajs/core/capabilities"
 *   import { R2Storage, withCapabilityBeacon } from "@nifrajs/storage"
 *
 *   const storage = withCapabilityBeacon(new R2Storage(env.BUCKET), { beacon: useCapability })
 *   await storage.for(c).put(key, bytes)   // announces `storage.write` first
 *
 * Evidence from the CALL is per-route and exact. Evidence from an import is per-module, so it is as
 * broad as the module holding it - which is why a beacon can say something a provenance rule cannot.
 */
import type { ListOptions, PutOptions, StorageAdapter, StorageData } from "./types.ts"

/**
 * `useCapability` from `@nifrajs/core/capabilities`, taken as a parameter rather than imported so this
 * package keeps its zero dependencies.
 */
export type CapabilityBeacon = (context: object, capability: string) => void

/** Tokens the wrapper announces. Defaults: `storage.read` and `storage.write`. */
export interface StorageCapabilities {
  readonly read?: string
  readonly write?: string
}

export interface StorageBeaconOptions {
  readonly beacon: CapabilityBeacon
  readonly capabilities?: StorageCapabilities
}

/** A storage adapter that can be bound to a request context. */
export interface BeaconingStorageAdapter extends StorageAdapter {
  /**
   * A view bound to a request context: every operation announces its capability first, and fails
   * closed when the route did not declare it.
   */
  for(context: object): StorageAdapter
}

/** Wrap an adapter so `for(context)` announces each operation's capability. */
export function withCapabilityBeacon(
  adapter: StorageAdapter,
  options: StorageBeaconOptions,
): BeaconingStorageAdapter {
  if (typeof options.beacon !== "function") {
    throw new TypeError("@nifrajs/storage: withCapabilityBeacon needs a beacon function")
  }
  const read = options.capabilities?.read ?? "storage.read"
  const write = options.capabilities?.write ?? "storage.write"

  // Built per call rather than cached per context: a map keyed by context would hold every request's
  // context for the process lifetime, which is a leak with a request attached to it.
  const bind = (context: object): StorageAdapter => {
    // A refused capability surfaces as a REJECTION, not a synchronous throw: every method returns a
    // promise, so a caller using `.catch(…)` rather than `try` would otherwise miss it entirely and a
    // fail-closed gate would read as an unhandled crash.
    const guard = <T>(capability: string, run: () => Promise<T>): Promise<T> => {
      try {
        options.beacon(context, capability)
      } catch (error) {
        return Promise.reject(error)
      }
      return run()
    }
    return {
      put: (key: string, data: StorageData, opts?: PutOptions): Promise<void> =>
        guard(write, () => adapter.put(key, data, opts)),
      get: (key) => guard(read, () => adapter.get(key)),
      delete: (key) => guard(write, () => adapter.delete(key)),
      exists: (key) => guard(read, () => adapter.exists(key)),
      list: (opts?: ListOptions) => guard(read, () => adapter.list(opts)),
    }
  }

  // The unbound adapter keeps working exactly as before, so wrapping is not a commitment to route
  // every call through a context - only the `for(...)` path announces anything.
  return {
    put: (key, data, opts) => adapter.put(key, data, opts),
    get: (key) => adapter.get(key),
    delete: (key) => adapter.delete(key),
    exists: (key) => adapter.exists(key),
    list: (opts) => adapter.list(opts),
    for: bind,
  }
}
