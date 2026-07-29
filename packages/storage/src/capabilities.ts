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
import type { StorageAdapter } from "./types.ts"

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

/**
 * Which capability each method announces.
 *
 * The five core methods plus the optional extensions an adapter may implement (`listPage` from
 * `PagedStorageAdapter`, `copy`/`move` from `MovableStorageAdapter`). `presign` is absent on purpose:
 * its token depends on the `operation` argument, since a PUT URL hands out write access.
 */
const ACCESS: Readonly<Record<string, "read" | "write">> = {
  get: "read",
  exists: "read",
  list: "read",
  listPage: "read",
  put: "write",
  delete: "write",
  copy: "write",
  move: "write",
}

/**
 * A storage adapter that can be bound to a request context.
 *
 * Generic over the adapter, so wrapping a `PresignableStorageAdapter` gives back something that still
 * presigns. The first version returned a plain `StorageAdapter` assembled from five hand-listed
 * methods, which silently dropped `presign`, `listPage`, `copy` and `move` - so adding beacons to a
 * certified S3 adapter quietly removed every optional capability it was certified for.
 */
export type BeaconingStorageAdapter<A extends StorageAdapter = StorageAdapter> = A & {
  /**
   * A view bound to a request context: every operation announces its capability first, and fails
   * closed when the route did not declare it.
   */
  for(context: object): A
}

/**
 * Wrap an adapter so `for(context)` announces each operation's capability.
 *
 * Forwarding is by Proxy rather than by enumeration, and that is the whole point: a wrapper that lists
 * the methods it knows about is a wrapper that silently deletes the ones it does not, and an adapter's
 * optional capabilities are precisely the methods a hand-written list forgets.
 */
export function withCapabilityBeacon<A extends StorageAdapter>(
  adapter: A,
  options: StorageBeaconOptions,
): BeaconingStorageAdapter<A> {
  if (typeof options.beacon !== "function") {
    throw new TypeError("@nifrajs/storage: withCapabilityBeacon needs a beacon function")
  }
  const read = options.capabilities?.read ?? "storage.read"
  const write = options.capabilities?.write ?? "storage.write"

  /**
   * The token a call announces. `presign` reads its `operation` argument, because minting a PUT URL
   * hands the holder write access to the bucket and must not be evidenced as a read.
   *
   * An unrecognised method announces WRITE. A declaration describes what a route MAY do, so the
   * conservative answer is the correct one - an adapter extension nobody mapped should fail closed
   * against a read-only route rather than slip through unannounced.
   */
  const tokenFor = (method: string, args: readonly unknown[]): string => {
    if (method === "presign") return args[1] === "put" ? write : read
    return ACCESS[method] === "read" ? read : write
  }

  // Built per call rather than cached per context: a map keyed by context would hold every request's
  // context for the process lifetime, which is a leak with a request attached to it.
  const bind = (context: object): A =>
    new Proxy(adapter, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (typeof value !== "function" || typeof prop !== "string") return value
        return (...args: unknown[]): unknown => {
          // A refused capability surfaces as a REJECTION, not a synchronous throw: these methods return
          // promises, so a caller reaching for `.catch(…)` rather than `try` would otherwise miss it and
          // a fail-closed gate would read as an unhandled crash.
          try {
            options.beacon(context, tokenFor(prop, args))
          } catch (error) {
            return Promise.reject(error)
          }
          return Reflect.apply(value as (...a: unknown[]) => unknown, target, args)
        }
      },
    }) as A

  // The unbound adapter keeps working exactly as before - now actually true, including for methods
  // this module has never heard of. Only the `for(...)` path announces anything.
  return new Proxy(adapter, {
    get: (target, prop, receiver) => (prop === "for" ? bind : Reflect.get(target, prop, receiver)),
    has: (target, prop) => prop === "for" || Reflect.has(target, prop),
  }) as BeaconingStorageAdapter<A>
}
