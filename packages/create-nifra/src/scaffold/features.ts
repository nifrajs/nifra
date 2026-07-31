/**
 * What a feature adds to a scaffold's manifest, and the one place those additions are merged.
 *
 * `--db`, `--auth`, `--deploy` and `--ci` each used to reach into the parsed `package.json` and spread
 * themselves over it, in an order fixed by the line they appeared on. That works until two of them
 * want the same key: the later spread wins, silently, and a preset that shadowed the scaffold's own
 * `check` script would remove the assurance gate from every project scaffolded with it. No preset does
 * that today - all six were checked - which is exactly when to put the rail in.
 *
 * So a contribution says what it adds, and REPLACING an existing key has to be declared. A collision
 * nobody declared is an error rather than a last-writer-wins race between two option handlers.
 */

export interface FeatureContribution {
  /** How the feature names itself in a collision error, e.g. `--db drizzle-libsql`. */
  readonly label: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
  readonly scripts?: Readonly<Record<string, string>>
  /**
   * Keys this feature intends to overwrite. `--deploy` repoints `build` and `deploy` at the chosen
   * target, which is the whole point of the flag - so it says so, and every other collision stays an
   * error. The distinction is the feature: declared replacement is a decision, silent replacement is
   * the bug this exists to catch.
   */
  readonly replaces?: readonly string[]
}

export interface ScaffoldManifest {
  name?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const SECTIONS = ["scripts", "dependencies", "devDependencies"] as const

/**
 * Merge every feature's contribution into the scaffold's manifest.
 *
 * Applied in order, but the order no longer decides anything: a key two features both want, or a key a
 * feature would take from the scaffold without saying so, throws naming both sides. That turns a
 * question you would have to reason about into one the scaffolder answers.
 */
export function applyFeatures(
  manifest: ScaffoldManifest,
  contributions: readonly FeatureContribution[],
): void {
  /** Who last wrote each key, so a collision can name the other side rather than just the winner. */
  const owner = new Map<string, string>()
  for (const section of SECTIONS) {
    for (const key of Object.keys(manifest[section] ?? {}))
      owner.set(`${section}.${key}`, "the scaffold")
  }

  for (const contribution of contributions) {
    const declared = new Set(contribution.replaces ?? [])
    for (const section of SECTIONS) {
      const additions = contribution[section]
      if (additions === undefined) continue
      manifest[section] ??= {}
      const target = manifest[section]
      for (const [key, value] of Object.entries(additions)) {
        const previous = owner.get(`${section}.${key}`)
        if (previous !== undefined && !declared.has(key) && target[key] !== value) {
          throw new Error(
            `${contribution.label} would overwrite ${section}.${key} from ${previous}. ` +
              "Declare it in `replaces` if that is intended.",
          )
        }
        target[key] = value
        owner.set(`${section}.${key}`, contribution.label)
      }
    }
  }
}
