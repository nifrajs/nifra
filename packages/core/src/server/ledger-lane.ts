/**
 * The opt-in per-request effect ledger. Installed by `.use(effectLedger())` and reached only by routes
 * that declare `schema.capabilities`, so the kernel never statically imports this code: a bare
 * `server()` tree-shakes the ledger machinery out.
 *
 * The kernel resolves a capability-declaring route's ledger wiring at registration (via
 * {@link EffectLedgerRuntime.resolve}) and, on the request path, creates + attaches a ledger before the
 * handler and settles it after (via {@link EffectLedgerRuntime.create}/`attach`/`settle`). Nothing here
 * depends on server internals; the sink-error log is supplied per settle.
 */
import {
  attachEffectLedger,
  createRequestLedger,
  DEFAULT_MAX_ENTRIES,
  type EffectLedgerOptions,
  type RequestLedger,
} from "../ledger.ts"
import { INSTALL_EFFECT_LEDGER } from "./install.ts"
import type { AnyServer, IdentityPlugin } from "./server.ts"

/** Registration-resolved effect-ledger wiring for one capability-declaring route. */
export interface ResolvedEffectLedger {
  readonly sink: EffectLedgerOptions["sink"]
  readonly maxEntries: number
  readonly chain: boolean
  /** The registered route pattern - what the sealed ledger names (never the concrete URL). */
  readonly method: string
  readonly path: string
  /** The route's declared capability tokens, surfaced on the sealed ledger. */
  readonly declared: readonly string[]
}

/** The injected effect-ledger implementation the kernel calls through when the plugin is installed. */
export interface EffectLedgerRuntime {
  /** Resolve a capability-declaring route into its ledger wiring, or `undefined` when it declares none. */
  resolve(
    capabilities: readonly string[],
    method: string,
    path: string,
  ): ResolvedEffectLedger | undefined
  /** Create the per-request ledger for a ledgered route. */
  create(resolved: ResolvedEffectLedger): RequestLedger
  /** Attach a ledger to the request context so `useCapability` can append to it. */
  attach(context: object, ledger: RequestLedger): void
  /** Seal the ledger and deliver it to the sink (empty ledgers are not delivered). */
  settle<T>(
    ledger: RequestLedger,
    resolved: ResolvedEffectLedger,
    value: T,
    onSinkError: (fields: { method: string; path: string; name: string }) => void,
  ): Promise<T>
}

/**
 * Build an effect-ledger runtime from the app-wide options. `sink` receives the sealed, token-only
 * ledger when a capability-declaring route settles with recorded entries; `maxEntries` bounds a single
 * request's ledger; `chain` opts into the per-entry hash chain.
 */
export function createEffectLedgerRuntime(options: EffectLedgerOptions): EffectLedgerRuntime {
  if (typeof options.sink !== "function") {
    throw new TypeError("effectLedger.sink must be a function")
  }
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError("effectLedger.maxEntries must be a positive safe integer")
  }
  const chain = options.chain ?? false
  const sink = options.sink

  return {
    resolve(capabilities, method, path) {
      if (capabilities.length === 0) return undefined
      return Object.freeze({ sink, maxEntries, chain, method, path, declared: capabilities })
    },
    create(resolved) {
      return createRequestLedger({
        method: resolved.method,
        path: resolved.path,
        declared: resolved.declared,
        maxEntries: resolved.maxEntries,
        chain: resolved.chain,
      })
    },
    attach(context, ledger) {
      attachEffectLedger(context, ledger)
    },
    async settle(ledger, resolved, value, onSinkError) {
      const sealed = await ledger.seal()
      if (sealed.entries.length === 0) return value
      try {
        await resolved.sink(sealed)
      } catch (err) {
        // Token-only: the route pattern and the failure name - never entry payloads (there are none)
        // and never the request. The ledger is observational, so a sink outage never fails the effect.
        onSinkError({
          method: resolved.method,
          path: resolved.path,
          name: err instanceof Error ? err.name : "Error",
        })
      }
      return value
    },
  }
}

/** The install seam a server exposes so the `effectLedger()` plugin can hand it a runtime. */
interface EffectLedgerInstallable {
  [INSTALL_EFFECT_LEDGER](runtime: EffectLedgerRuntime): void
}

/**
 * Enable the per-request effect ledger. Each route that declares `schema.capabilities` gets a bounded,
 * token-only ledger; `useCapability(c, id, …)` appends one entry per effect, and the sink receives the
 * sealed ledger when the response settles (only when it recorded entries). Token-only by construction -
 * capability ids, phases, counters, digests; never payloads, values, or the concrete URL (the route
 * pattern is recorded). Without this plugin, capability-declaring routes simply carry no ledger.
 */
export function effectLedger(options: EffectLedgerOptions): IdentityPlugin {
  const runtime = createEffectLedgerRuntime(options)
  const apply = <S extends AnyServer>(app: S): S => {
    ;(app as unknown as EffectLedgerInstallable)[INSTALL_EFFECT_LEDGER](runtime)
    return app
  }
  return Object.assign(apply, { pluginName: "nifra:effect-ledger" }) as IdentityPlugin
}
