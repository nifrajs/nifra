/**
 * Per-release upgrade recipes, as data. Each recipe declares the mechanical edits a target version
 * needs — dependency pins and exact import-specifier moves — so `nifra upgrade <version>` can apply
 * them deterministically. Recipes are static imports (they bundle) and keyed by target version.
 */

import { recipe as v1_8_0 } from "./1.8.0.ts"

/** A pin rule: every dependency whose name starts with `match` is set to version `to`. */
export interface PinRule {
  /** Package-name prefix, e.g. `@nifrajs/`, or an exact package name. */
  readonly match: string
  /** Bare target version, e.g. `1.8.0`. The range operator (`^`/`~`/exact) is preserved per-spec. */
  readonly to: string
}

/** An exact import-specifier rewrite (string-level, not AST): `from` → `to`. */
export interface ImportMove {
  readonly from: string
  readonly to: string
}

export interface UpgradeRecipe {
  readonly version: string
  readonly pins: readonly PinRule[]
  readonly importMoves: readonly ImportMove[]
  /** Human notes printed after the plan — e.g. structural changes the runner deliberately can't do. */
  readonly notes?: readonly string[]
}

const RECIPES: Record<string, UpgradeRecipe> = {
  [v1_8_0.version]: v1_8_0,
}

export function getRecipe(version: string): UpgradeRecipe | undefined {
  return RECIPES[version]
}

/** Available target versions, ascending. */
export function listRecipeVersions(): string[] {
  return Object.keys(RECIPES).sort((a, b) => compareVersions(a, b))
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
