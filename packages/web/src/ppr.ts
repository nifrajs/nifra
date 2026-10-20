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
import type { ShellCtx } from "./boundary.ts"
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

export {
  type CompileShellsOptions,
  compileShells,
  ShellCheckError,
  type ShellCheckRecord,
} from "./internal/ppr/compile-shell.ts"
export { PPR_DEFAULTS, type PprOptions } from "./internal/ppr/options.ts"
export type { PprSetup, ShellCtx }

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
  const { origin, shellChecks } = config
  if (origin !== undefined && !isOrigin(origin)) {
    throw new TypeError(
      `[nifra/web] experimental.ppr.origin must be an http(s) origin such as "https://shop.example", with no path; got ${JSON.stringify(origin)}`,
    )
  }
  return {
    [PPR_SETUP]: (environment) => createPprIntegration(options, shellChecks, origin, environment),
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
  /** Drop every shell whose route listed `tag` in `revalidateTags`; a build running now is not kept. */
  invalidateTag(tag: string): void
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
