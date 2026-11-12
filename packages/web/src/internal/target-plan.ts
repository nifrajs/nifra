import type { BuildManifest, ServerBuild } from "../build-plan.ts"
import type { CssLoadingMode } from "../css-contract.ts"
import type { LiveClientEntry } from "./codegen.ts"
import type { SecretExemption } from "./secret-scan.ts"

/** A deploy target `nifra build --target <t>` can emit. `static` is pure SSG (no server). */
export const BUILD_TARGETS = ["bun", "node", "deno", "cloudflare", "vercel", "static"] as const
export type BuildTarget = (typeof BUILD_TARGETS)[number]

/** Ordinary Vercel SSR uses Edge unless Node is explicitly selected. */
export type VercelRuntime = "edge" | "node"

/** Validate before any deploy directory is cleared, including untyped config/API callers. */
export function validateVercelRuntime(target: BuildTarget, runtime: unknown): void {
  if (runtime === undefined) return
  if (runtime !== "edge" && runtime !== "node") {
    throw new Error('[nifra/web] vercelRuntime must be "edge" or "node"')
  }
  if (target !== "vercel") {
    throw new Error('[nifra/web] vercelRuntime is only supported for target "vercel"')
  }
}

/** A type guard narrowing an arbitrary string to a {@link BuildTarget}. */
export function isBuildTarget(value: string): value is BuildTarget {
  return BUILD_TARGETS.some((target) => target === value)
}

/** `value` as a {@link BuildTarget}, or throw naming the valid ones (and the renamed `cf-pages`). */
export function parseBuildTarget(value: string, label = "target"): BuildTarget {
  if (isBuildTarget(value)) return value
  throw new Error(
    value === "cf-pages"
      ? `[nifra] the ${label} "cf-pages" is now "cloudflare"`
      : `[nifra] unknown ${label} "${value}". Valid: ${BUILD_TARGETS.join(", ")}`,
  )
}

export type ServerBuildTarget = "browser" | "node" | "bun"

export interface StaticBuildTargetPlan {
  readonly target: "static"
  readonly kind: "static"
  readonly serverTarget: undefined
  readonly outputFile: undefined
  readonly staticDir: ""
  readonly run: string
}

export interface ServerBuildTargetPlan {
  readonly target: Exclude<BuildTarget, "static">
  readonly kind: "server"
  readonly serverTarget: ServerBuildTarget
  /** The worker's final path inside the assembled deploy directory. */
  readonly outputFile: "_worker.js" | "functions/index.func/index.js" | "server.js"
  /** Where the host serves static files from, relative to the deploy directory (`""` = its root). */
  readonly staticDir: "" | "static"
  readonly run: string
}

export type BuildTargetPlan = StaticBuildTargetPlan | ServerBuildTargetPlan

const finalPathSegment = (path: string): string => {
  // Do not use a repeated, unanchored regex here: a separator-heavy path followed by a
  // non-separator can make the regex engine retry every possible start position (ReDoS).
  let end = path.length
  while (end > 0) {
    const code = path.charCodeAt(end - 1)
    if (code !== 0x2f && code !== 0x5c) break
    end -= 1
  }
  const trimmed = path.slice(0, end)
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

/**
 * Resolve the target-specific deploy shape before any bundling starts. Keeping this decision pure
 * means Bun and Vite strategies share the same output filename, server target, and hand-off text;
 * the filesystem emitter only has to execute the plan.
 */
export function planBuildTarget(
  target: BuildTarget,
  outDir: string,
  vercelRuntime?: VercelRuntime,
): BuildTargetPlan {
  validateVercelRuntime(target, vercelRuntime)
  if (target === "static") {
    return {
      target,
      kind: "static",
      serverTarget: undefined,
      outputFile: undefined,
      staticDir: "",
      run: `static site → ${outDir} (serve the directory with any static host)`,
    }
  }
  if (target === "cloudflare") {
    return {
      target,
      kind: "server",
      serverTarget: "browser",
      outputFile: "_worker.js",
      staticDir: "",
      run: `Cloudflare Pages → ${outDir} (deploy: wrangler pages deploy ${finalPathSegment(outDir)})`,
    }
  }
  if (target === "vercel") {
    return {
      target,
      kind: "server",
      serverTarget: vercelRuntime === "node" ? "node" : "browser",
      // Vercel's Build Output API: `vercel deploy --prebuilt` uploads this tree as it is.
      outputFile: "functions/index.func/index.js",
      staticDir: "static",
      run: `Vercel (Build Output API) → ${outDir} (deploy: vercel deploy --prebuilt)`,
    }
  }
  return {
    target,
    kind: "server",
    serverTarget: target === "node" ? "node" : target === "bun" ? "bun" : "browser",
    outputFile: "server.js",
    staticDir: "",
    run: `${target} server → ${outDir} (run: ${target === "node" ? "node" : target} ${finalPathSegment(outDir)}/server.js)`,
  }
}

/**
 * A build-tool STRATEGY for {@link buildTargetWith} - the two bundling steps, and nothing else. Everything
 * around them (server-entry codegen, deploy assembly, prerender, size report) is bundler-agnostic and
 * lives in `buildTargetWith`, so a second bundler (Vite) is this interface, not a second orchestrator.
 *
 * Plugin lists are `readonly unknown[]` because a Bun plugin and a Vite plugin are different types; each
 * strategy casts to its own. `buildTargetWith` only forwards them.
 */
export interface Bundler {
  /** Build the client bundle → the shared {@link BuildManifest}. */
  buildClient(input: {
    readonly routesDir: string
    readonly outDir: string
    readonly clientModule: string
    readonly plugins?: readonly unknown[]
    readonly conditions?: readonly string[]
    readonly define?: Readonly<Record<string, string>>
    readonly publicDir?: string | false
    readonly publicEnvPrefix?: string
    /** Vite CSS splitting policy; the Bun strategy rejects `false` and otherwise preserves its native behavior. */
    readonly cssCodeSplit?: boolean
    /** Framework-owned stylesheet activation policy; supported by both server strategies. */
    readonly cssLoading?: CssLoadingMode
    /** Project root (Vite needs it; the Bun strategy ignores it). */
    readonly root?: string
    /** Reviewed false positives of the secret scan. */
    readonly secretExemptions?: readonly SecretExemption[]
    /** The client entry for a live server (`BuildClientOptions.live`). */
    readonly live?: LiveClientEntry | undefined
    /** The router's server `fetch` module (`BuildClientOptions.transport`). */
    readonly transport?: string | undefined
  }): Promise<BuildManifest>
  /** Build the server worker → the shared {@link ServerBuild}. */
  buildServer(input: {
    readonly routesDir: string
    readonly serverEntry: string
    readonly outDir: string
    readonly clientEntry: string
    readonly target: "browser" | "node" | "bun"
    /** The client build's aggregate stylesheet URLs to bake into the server manifest. */
    readonly styles?: readonly string[]
    /** The client build's per-route stylesheet map to bake into the server manifest. */
    readonly routeStyles?: Readonly<Record<string, readonly string[]>>
    /** The client build's copy chunk URLs by locale to bake into the server manifest. */
    readonly copyChunks?: Readonly<Record<string, string>>
    /** Every file the build emitted, by request path, to bake into the server manifest. */
    readonly buildAssets?: readonly string[]
    readonly plugins?: readonly unknown[]
    readonly define?: Readonly<Record<string, string>>
    /** CSS activation policy to bake into the generated server manifest. */
    readonly cssLoading?: CssLoadingMode
    readonly root?: string
    /** Modules the zone rules treat as generated: the adapter module the generated entry imports. */
    readonly generatedFiles?: readonly string[]
    /** The public-env prefix browser code may read (default `"PUBLIC_"`). */
    readonly publicEnvPrefix?: string
    /** Node built-ins the runtime provides besides what `target` implies, kept as imports. */
    readonly providedBuiltins?: readonly string[]
  }): Promise<ServerBuild>
}
