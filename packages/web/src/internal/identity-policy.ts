/**
 * One source for which packages are identity-sensitive, and how each frontend framework is pinned to a
 * single physical copy in a bundle.
 *
 * The identity-sensitive PACKAGE set lives in `@nifrajs/core` (`IDENTITY_SENSITIVE_PACKAGES`) - it is
 * what single-copy enforcement and `nifra check` read, and it must be the same answer everywhere. This
 * module does not restate it; it re-exports the one predicate every web caller should ask
 * (`isIdentitySensitivePackage`) so a second list can never drift from core's.
 *
 * What this module DOES own is the per-bundler dedupe STRATEGY, which is a web concern (it names Bun and
 * Vite mechanics core knows nothing about). The two client pipelines - `Bun.build` (build.ts) and Vite
 * (build-vite.ts) - used to spell their framework coverage out independently, and they had already
 * drifted: the Bun build pinned react + preact + svelte while the Vite build deduped react alone, so a
 * Vite-built app silently shipped a second Preact or Svelte runtime. Both now read {@link
 * FRONTEND_DEDUPE_POLICIES}, so their coverage cannot diverge again.
 *
 * Not every identity-sensitive framework is name-pinned here. Solid and Vue select their single runtime
 * through export CONDITIONS rather than a resolver override, so they carry no entry - the conformance
 * test allows core's set to be a superset of this table for exactly that reason, and only forbids the
 * reverse (a strategy for a package core does not consider identity-sensitive).
 */

import {
  IDENTITY_SENSITIVE_PACKAGES,
  matchesSingleCopyDeclaration,
} from "@nifrajs/core/single-copy"

/**
 * Whether nifra treats a package as identity-sensitive: a second physical copy breaks behaviour (a hook
 * dispatcher, a renderer's options global, a `Server` class identity) rather than merely costing bytes.
 * The single predicate the whole web package asks, delegating to core's canonical declaration.
 */
export const isIdentitySensitivePackage = (name: string): boolean =>
  matchesSingleCopyDeclaration(IDENTITY_SENSITIVE_PACKAGES, name)

/**
 * How one frontend framework's runtime is pinned to a single copy in each client bundler.
 *
 * The two arms differ because the bundlers resolve differently. `Bun.build` needs an `onResolve` hook,
 * fed either a fixed specifier list (each resolved once) or a pattern (resolved per matched import, for
 * a framework with an open-ended subpath surface like `svelte/internal/*`). Vite takes bare package
 * names in `resolve.dedupe` and handles the subpaths itself. A framework declares whichever Bun arm
 * fits plus its Vite names, so both pipelines pin the same framework from this one entry.
 */
export interface FrontendDedupePolicy {
  readonly framework: string
  /** Exact specifiers the Bun build pins to the app's copy. Mutually exclusive with `bunPattern`. */
  readonly bunSpecs?: readonly string[]
  /** Specifier pattern the Bun build resolves per match, for an open-ended subpath surface. */
  readonly bunPattern?: RegExp
  /** Bare package names the Vite build lists in `resolve.dedupe`. */
  readonly viteDedupe: readonly string[]
}

export const FRONTEND_DEDUPE_POLICIES: readonly FrontendDedupePolicy[] = [
  {
    framework: "react",
    // react-dom is absent on purpose: it imports react, so pinning react's core (and its JSX runtimes)
    // gives it the one dispatcher. Vite dedupes react-dom by name because it collapses by package.
    bunSpecs: ["react", "react/jsx-runtime", "react/jsx-dev-runtime"],
    viteDedupe: ["react", "react-dom"],
  },
  {
    framework: "preact",
    bunSpecs: [
      "preact",
      "preact/hooks",
      "preact/compat",
      "preact/jsx-runtime",
      "preact/jsx-dev-runtime",
    ],
    viteDedupe: ["preact"],
  },
  {
    framework: "svelte",
    // Svelte's client runtime has many internal subpaths, so match the family and resolve each per hit.
    bunPattern: /^svelte($|\/internal\/)/,
    viteDedupe: ["svelte"],
  },
]

/** Look up one framework's dedupe policy, throwing if a plugin references a framework the table dropped. */
export const dedupePolicyFor = (framework: string): FrontendDedupePolicy => {
  const policy = FRONTEND_DEDUPE_POLICIES.find((entry) => entry.framework === framework)
  if (policy === undefined) {
    throw new Error(`[nifra/web] no frontend dedupe policy for ${framework}`)
  }
  return policy
}

/** The flat, de-duplicated `resolve.dedupe` list for the Vite client build. */
export const viteDedupePackages = (): readonly string[] => [
  ...new Set(FRONTEND_DEDUPE_POLICIES.flatMap((policy) => policy.viteDedupe)),
]
