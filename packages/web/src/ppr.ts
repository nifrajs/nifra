/**
 * `@nifrajs/web/ppr` - experimental and unstable: partial prerendering.
 *
 * A route whose backend half exports `shellLoader` streams a shell shared by every visitor, then each
 * `dynamic` boundary as it settles. Turn it on with `createWebApp({ experimental: { ppr:
 * partialPrerendering({ shellChecks }) } })`, where `shellChecks` is the record `compileShells` returns
 * for this deployment; a route left out of it renders whole. `pprShells(app)` reaches the shell cache,
 * for `createInvalidator`'s `dataCaches` and for metrics. The server lives in this module, so an app
 * that never imports it ships none of it. Backend-only: a browser build that reaches this module fails.
 */
import "@nifrajs/web/backend-only"
import type { SharedHoleCtx, ShellCtx } from "./boundary.ts"
import type { ShellCheckRecord } from "./internal/ppr/compile-shell.ts"
import {
  PPR_SERVER,
  PPR_SETUP,
  type PprServer,
  type PprServerStats,
  type PprSetup,
} from "./internal/ppr/contract.ts"
import { createPprIntegration } from "./internal/ppr/integration.ts"
import { type PprOptions, resolvePprOptions } from "./internal/ppr/options.ts"
import { MIN_STORE_SECRET_LENGTH } from "./internal/ppr/shell-store.ts"
import type { CacheStore } from "./isr.ts"

export {
  type CanaryCarrier,
  checkShellCanaries,
  type ShellCanaryFinding,
  type ShellCanaryOptions,
} from "./internal/ppr/canary.ts"
export {
  type CompileShellsOptions,
  compileShells,
  ShellCheckError,
  type ShellCheckRecord,
} from "./internal/ppr/compile-shell.ts"
export { PPR_DEFAULTS, type PprOptions } from "./internal/ppr/options.ts"
export type { PprSetup, SharedHoleCtx, ShellCtx }

export interface PprConfig {
  /** From `compileShells` for this deployment; `"unchecked-development"` is refused in production. */
  readonly shellChecks: ShellCheckRecord | "unchecked-development"
  /** Overrides for the defaults in `PPR_DEFAULTS`. */
  readonly options?: PprOptions
  /**
   * The deployment's public origin, such as `https://shop.example`, given to `shellLoader` and to the
   * shell's `meta` as `origin`. Without it both get `""`: a shell is shared, so no visitor's Host
   * header may supply it.
   */
  readonly origin?: string
  /**
   * A store the app's processes share, such as `new KVCacheStore(env.SHELLS)`, behind each process's
   * own shells and shared hole frames: a process that has not built one reads it from here. Needs
   * `storeSecret` and checked shells. A route whose tags the store cannot drop keeps its entries
   * in-process.
   */
  readonly store?: CacheStore
  /**
   * Signs every entry written to `store`, so a store other services can write cannot hand visitors
   * a page this app did not build. At least 32 characters, the same in every process.
   */
  readonly storeSecret?: string
  /**
   * The platform's name for this deployment, such as a commit or a version id. Shells are already
   * kept apart by the client build and by each route's checked shell code; this adds to that.
   */
  readonly deployment?: string
}

/** `value` is exactly an http(s) origin: a scheme, a host and an optional port, nothing after. */
function isOrigin(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value
}

/**
 * Experimental: partial prerendering for `createWebApp({ experimental: { ppr } })`. Options are
 * checked here, at startup; each app the value is given to gets its own shell cache.
 */
export function partialPrerendering(config: PprConfig): PprSetup {
  const options = resolvePprOptions(config.options)
  const { origin, shellChecks, store, storeSecret, deployment } = config
  if (origin !== undefined && !isOrigin(origin)) {
    throw new TypeError(
      `[nifra/web] experimental.ppr.origin must be an http(s) origin such as "https://shop.example", with no path; got ${JSON.stringify(origin)}`,
    )
  }
  if (deployment !== undefined && (typeof deployment !== "string" || deployment === "")) {
    throw new TypeError("[nifra/web] experimental.ppr.deployment must be a non-empty string")
  }
  if (store !== undefined) {
    if (shellChecks === "unchecked-development") {
      throw new TypeError(
        "[nifra/web] experimental.ppr.store needs the build's shell check records: an unchecked shell is never shared",
      )
    }
    if (typeof storeSecret !== "string" || storeSecret.length < MIN_STORE_SECRET_LENGTH) {
      throw new TypeError(
        `[nifra/web] experimental.ppr.store needs storeSecret, at least ${MIN_STORE_SECRET_LENGTH} characters, to sign the shells it shares`,
      )
    }
  }
  return {
    [PPR_SETUP]: (environment) =>
      createPprIntegration(options, shellChecks, origin, environment, {
        store,
        storeSecret,
        deployment,
      }),
  }
}

/** Types a backend half's `shellLoader` from its context; returns it unchanged. */
export const defineShellLoader = <Data>(
  loader: (ctx: ShellCtx) => Data | Promise<Data>,
): ((ctx: ShellCtx) => Data | Promise<Data>) => loader

/** Admission, shedding and unsent-byte counters of one app's partially prerendered responses. */
export type PprStats = PprServerStats

/** One app's shell cache. */
export interface PprShells {
  /**
   * Drop every shell whose route listed `tag` in `revalidateTags`, here and in the shared store; a
   * build running now is not kept.
   */
  invalidateTag(tag: string): Promise<void>
  stats(): PprStats
}

const isPprServer = (value: unknown): value is PprServer =>
  typeof value === "object" && value !== null && "invalidateTag" in value && "stats" in value

/**
 * The shell cache of an app made with `experimental.ppr`. Pass it in `createInvalidator`'s
 * `dataCaches` so a purge by tag also drops the shells built from the purged data.
 */
export function pprShells(app: object): PprShells {
  const server: unknown = Reflect.get(app, PPR_SERVER)
  if (!isPprServer(server)) {
    throw new TypeError("[nifra/web/ppr] pprShells: this app was created without experimental.ppr")
  }
  return {
    invalidateTag: (tag) => server.invalidateTag(tag),
    stats: () => server.stats(),
  }
}
