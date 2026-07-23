/**
 * Pipeline separation guard — one bundler owns a phase, never two.
 *
 * nifra supports both Vite and Bun, and the config keeps them in separate slots: `vitePlugins` for
 * the Vite pipeline, `clientPlugins`/`serverPlugins` for the Bun one. Nothing enforces the split, so
 * a plugin lands in the wrong slot and is silently ignored - a Vite plugin in `clientPlugins` is
 * handed to `Bun.build`, which has no `transform` hook to call, so the transform simply never runs
 * and the build succeeds.
 *
 * That failure mode is the whole reason for this file. nifra's expensive bugs are not caused by Vite
 * or by Bun; they are caused by two toolchains disagreeing about one module. Dual-React is that, the
 * dedupe plugins are patches for that, and a `resolve.alias` that never reaches SSR is that. Mixing
 * is the defect - choice is not - so the separation has to be checked rather than documented.
 *
 * Detection is by hook shape, which is what each bundler actually dispatches on:
 *   - a Bun plugin has `setup(build)`
 *   - a Rollup/Vite plugin has `resolveId` / `load` / `transform` / `config` / `configResolved` /
 *     `transformIndexHtml` and no `setup`
 *
 * Deliberately conservative: a plugin that matches neither shape is left alone rather than guessed
 * at. A guard that fires on correct config is a guard people turn off.
 */

/** Which pipeline a slot belongs to. */
export type PipelineSlot = "vitePlugins" | "clientPlugins" | "serverPlugins"

export interface PipelineMismatch {
  readonly slot: PipelineSlot
  /** The plugin's `name`, or a positional label when it has none. */
  readonly plugin: string
  /** The pipeline the slot feeds. */
  readonly expected: "vite" | "bun"
  /** The pipeline the plugin's hooks say it belongs to. */
  readonly actual: "vite" | "bun"
  readonly fix: string
}

const ROLLUP_HOOKS = [
  "resolveId",
  "load",
  "transform",
  "config",
  "configResolved",
  "configureServer",
  "transformIndexHtml",
  "generateBundle",
  "renderChunk",
] as const

/** Classify a plugin by the hooks it exposes, or `undefined` when its shape says nothing. */
function classify(plugin: unknown): "vite" | "bun" | undefined {
  if (typeof plugin !== "object" || plugin === null) return undefined
  const record = plugin as Record<string, unknown>
  // `setup` is Bun's only entry point, so its presence is decisive even alongside other keys.
  if (typeof record.setup === "function") return "bun"
  if (ROLLUP_HOOKS.some((hook) => typeof record[hook] === "function")) return "vite"
  return undefined
}

const SLOT_PIPELINE: Readonly<Record<PipelineSlot, "vite" | "bun">> = {
  vitePlugins: "vite",
  clientPlugins: "bun",
  serverPlugins: "bun",
}

const MOVE_TO: Readonly<Record<"vite" | "bun", string>> = {
  vite: "`vitePlugins`",
  bun: "`clientPlugins` (client bundle) or `serverPlugins` (SSR)",
}

/**
 * Check one slot's resolved plugin list. Pure: takes the already-resolved array so a thunk-valued
 * field is awaited by the caller, and so this stays testable without loading a project.
 */
export function checkPipelineSlot(
  slot: PipelineSlot,
  plugins: readonly unknown[],
): PipelineMismatch[] {
  const expected = SLOT_PIPELINE[slot]
  const out: PipelineMismatch[] = []
  for (let i = 0; i < plugins.length; i++) {
    const plugin = plugins[i]
    const actual = classify(plugin)
    if (actual === undefined || actual === expected) continue
    const named = (plugin as { name?: unknown }).name
    const label = typeof named === "string" && named !== "" ? named : `${slot}[${i}]`
    out.push({
      slot,
      plugin: label,
      expected,
      actual,
      fix:
        actual === "vite"
          ? `"${label}" is a Vite/Rollup plugin (it defines Rollup hooks, not \`setup\`) but sits in \`${slot}\`, which feeds Bun.build. Bun never calls those hooks, so the transform silently does not run. Move it to ${MOVE_TO.vite}.`
          : `"${label}" is a Bun plugin (it defines \`setup\`) but sits in \`${slot}\`, which feeds Vite. Vite never calls \`setup\`, so the transform silently does not run. Move it to ${MOVE_TO.bun}.`,
    })
  }
  return out
}

/** Check every slot of a resolved framework config. */
export function checkPipelineSeparation(slots: {
  readonly vitePlugins?: readonly unknown[]
  readonly clientPlugins?: readonly unknown[]
  readonly serverPlugins?: readonly unknown[]
}): PipelineMismatch[] {
  return [
    ...checkPipelineSlot("vitePlugins", slots.vitePlugins ?? []),
    ...checkPipelineSlot("clientPlugins", slots.clientPlugins ?? []),
    ...checkPipelineSlot("serverPlugins", slots.serverPlugins ?? []),
  ]
}

/** Which bundler a build runs on. */
export type BuildPipeline = "bun" | "vite"

export interface PipelineDecision {
  readonly pipeline: BuildPipeline
  /**
   * Why this pipeline, for the `nifra build` log line - so an auto-selected Vite build never looks
   * like the user got the default. `undefined` when the choice was the plain default or was forced.
   */
  readonly reason?: string
}

/** The plugin slots a decision reads, already resolved. */
export interface PipelineSlots {
  readonly vitePlugins?: readonly unknown[]
  readonly clientPlugins?: readonly unknown[]
  readonly serverPlugins?: readonly unknown[]
}

const pluginNames = (plugins: readonly unknown[]): string =>
  plugins
    .map((plugin, i) => {
      const named = (plugin as { name?: unknown }).name
      return typeof named === "string" && named !== "" ? named : `vitePlugins[${i}]`
    })
    .join(", ")

/**
 * Pick the bundler for `nifra build`, per app rather than per global default.
 *
 * The phase defaults are deliberately asymmetric - `nifra dev` is Vite (for the plugin ecosystem, and
 * because Bun's DEV-server bundler cannot compile CSS Modules), `nifra build` is Bun (faster and
 * Bun-native). For an app with no transforms that asymmetry is free: there is nothing to disagree about.
 * For an app whose ONLY transforms are Vite plugins it is not. Those plugins run in dev and are then
 * dropped by the Bun build - `buildForTarget` reads `clientPlugins`/`serverPlugins`, never `vitePlugins`
 * - so the build succeeds, the output looks plausible, and the transform simply did not happen. That is
 * the same failure {@link checkPipelineSeparation} exists to prevent, reached by crossing PHASES instead
 * of slots, and the slot check cannot see it because the plugins are correctly placed.
 *
 * So the default follows the app: Vite plugins with no Bun counterpart means the app has exactly one
 * pipeline that can build it, and that is the one used. An app declaring BOTH has supplied the Bun
 * equivalent on purpose - nothing is dropped - so the fast Bun default stands.
 *
 * `forced` is `--vite` / `--bun` and always wins, except for the one combination that silently discards
 * work, which throws instead. Refusing rather than warning matches the slot guard: a build that succeeds
 * and omits the transform is worse than one that stops and says so.
 */
export function chooseBuildPipeline(
  slots: PipelineSlots,
  forced?: BuildPipeline,
): PipelineDecision {
  const vitePlugins = slots.vitePlugins ?? []
  const bunPlugins = [...(slots.clientPlugins ?? []), ...(slots.serverPlugins ?? [])]
  const viteOnly = vitePlugins.length > 0 && bunPlugins.length === 0

  if (forced === "bun" && viteOnly) {
    throw new Error(
      "[nifra] `nifra build --bun` would silently drop this app's only transforms. `vitePlugins` are " +
        "read by the Vite build; the Bun build reads `clientPlugins`/`serverPlugins`, so these would " +
        "never run and the output would look plausible without them.\n" +
        `  Would be dropped: ${pluginNames(vitePlugins)}\n` +
        "  Drop the flag to build with Vite, or add the Bun equivalents to `clientPlugins`/`serverPlugins`.",
    )
  }
  if (forced !== undefined) return { pipeline: forced }
  if (viteOnly) {
    return {
      pipeline: "vite",
      reason: `auto: this app's only transforms are \`vitePlugins\` (${pluginNames(vitePlugins)}), which the Bun build cannot run`,
    }
  }
  return { pipeline: "bun" }
}
