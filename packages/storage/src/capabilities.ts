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

  /**
   * Proxy an extensible facade, never the adapter itself. A Proxy may not return a different value for
   * a frozen non-writable method property; targeting the adapter therefore throws an invariant error
   * before our wrapper can run. The facade preserves the prototype for `instanceof`, while every read,
   * write and call still delegates to the real instance (including `#private` brands).
   */
  const facade = (read: (prop: PropertyKey) => unknown, hasFor: boolean): A => {
    const target = Object.create(Object.getPrototypeOf(adapter)) as object
    return new Proxy(target, {
      get: (_target, prop) => read(prop),
      has: (_target, prop) => (hasFor && prop === "for") || Reflect.has(adapter, prop),
      ownKeys: () => Reflect.ownKeys(adapter),
      getOwnPropertyDescriptor: (_target, prop) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(adapter, prop)
        if (descriptor === undefined) return undefined
        // The facade is extensible, so expose a configurable data view without copying a frozen
        // descriptor onto the proxy target (which would recreate the invariant problem).
        return {
          configurable: true,
          enumerable: descriptor.enumerable ?? false,
          writable: true,
          value: read(prop),
        }
      },
      set: (_target, prop, value) => Reflect.set(adapter, prop, value, adapter),
    }) as A
  }

  // Built per call rather than cached per context: a map keyed by context would hold every request's
  // context for the process lifetime, which is a leak with a request attached to it.
  const bind = (context: object): A => {
    const methods = new Map<PropertyKey, unknown>()
    return facade((prop) => {
      const value = Reflect.get(adapter, prop, adapter)
      if (typeof value !== "function" || typeof prop !== "string") return value
      const cached = methods.get(prop)
      if (cached !== undefined) return cached
      const wrapped = (...args: unknown[]): unknown => {
        // A refused capability surfaces as a REJECTION, not a synchronous throw: these methods return
        // promises, so a caller reaching for `.catch(…)` rather than `try` would otherwise miss it.
        try {
          options.beacon(context, tokenFor(prop, args))
        } catch (error) {
          return Promise.reject(error)
        }
        return Reflect.apply(value as (...a: unknown[]) => unknown, adapter, args)
      }
      methods.set(prop, wrapped)
      return wrapped
    }, false)
  }

  // The unbound adapter keeps working exactly as before, including for methods this module has never
  // heard of. Only the `for(...)` path announces anything.
  //
  // Methods come back bound to the target for the same reason the getter reads against it. They are
  // cached per wrapper, so repeated property reads preserve identity and allocate once.
  //
  // An adapter with its own `for` method is shadowed by the wrapper's. That is a genuine (if unlikely)
  // collision, and `for` is the name the sibling beacons already use, so it stays consistent rather
  // than novel.
  const methods = new Map<PropertyKey, unknown>()
  return facade((prop) => {
    if (prop === "for") return bind
    const value = Reflect.get(adapter, prop, adapter)
    if (typeof value !== "function") return value
    const cached = methods.get(prop)
    if (cached !== undefined) return cached
    const bound = value.bind(adapter)
    methods.set(prop, bound)
    return bound
  }, true) as BeaconingStorageAdapter<A>
}
