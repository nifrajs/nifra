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
