/**
 * The two-pipeline rule, reported STATICALLY - which bundler this app runs on, and the config hazards
 * that only exist because nifra supports two.
 *
 * `loadApp` already refuses a plugin in the wrong slot ({@link ./load.ts}), and `nifra dev`/`nifra build`
 * print the chosen bundler. Both of those need the app's config to be IMPORTED, which is code execution -
 * something `nifra check` deliberately never does, and something an agent inspecting a repo it has not
 * installed cannot do at all. So this reads the config as text instead.
 *
 * Text, not types, so the rules are chosen for the ones that survive being read rather than run:
 *
 *   - Which pipeline the app is on. `chooseBuildPipeline` decides from whether the plugin slots are
 *     empty, and "does this file declare a non-empty `vitePlugins`" is a question the source answers.
 *   - The adapter-entry hazard. `nifra build` imports the adapter from `framework.ts`, or from
 *     `nifra.config.ts` when there is no `framework.ts`, and bundles everything that file imports into
 *     the production server. A Vite plugin or an SFC compiler reached that way builds cleanly and then
 *     dies at startup on a missing native binding. Nothing runtime-side catches it: by then the build
 *     has already succeeded.
 *   - A plugin in the wrong slot, for the subset whose import specifier names its pipeline. The load
 *     guard classifies by hook shape and is authoritative; this catches the same thing earlier, before
 *     anything is installed or started.
 *   - `conditions` on the Bun pipeline, which reach SSR and cannot reach the dev client bundle.
 *
 * Everything here degrades to silence rather than guessing. A config that computes its plugins, or
 * re-exports them from elsewhere, yields `certain: false` and no findings - a static reader that
 * invents a pipeline is worse than one that says it could not tell.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { codePositionMask, stripComments } from "./check.ts"
import type { BuildPipeline } from "./pipeline-guard.ts"

/** A plugin slot, and the pipeline it feeds. */
const SLOT_PIPELINE = {
  vitePlugins: "vite",
  clientPlugins: "bun",
  serverPlugins: "bun",
} as const satisfies Readonly<Record<string, BuildPipeline>>

type Slot = keyof typeof SLOT_PIPELINE

const SLOTS = Object.keys(SLOT_PIPELINE) as readonly Slot[]

export interface PipelineFinding {
  readonly rule: "adapter-entry" | "plugin-slot" | "bun-client-conditions"
  readonly severity: "error" | "warning"
  /** Project-relative file the finding is in. */
  readonly file: string
  readonly line?: number
  readonly message: string
  readonly fix: string
}

export interface PipelineReport {
  /** `false` when the directory holds no `nifra.config.ts` or `framework.ts` - nothing to report on. */
  readonly ran: boolean
  /** The bundler `nifra dev` and `nifra build` will use, or `unknown` when the source can't say. */
  readonly pipeline: BuildPipeline | "unknown"
  /** Plain-language "why this bundler", in the same words the CLI prints. */
  readonly reason: string
  /**
   * Whether the config states its plugin slots outright. `false` when a slot is a thunk, an identifier,
   * or a re-export - the pipeline shown is then nifra's best reading, and `nifra dev` prints the real one.
   */
  readonly certain: boolean
  /** The config file read, project-relative. */
  readonly configFile?: string
  /** The file `nifra build` imports the adapter from - `framework.ts`, else the config. */
  readonly adapterEntry?: string
  readonly findings: readonly PipelineFinding[]
}

/**
 * Specifiers that carry a dev toolchain: Vite itself, a Vite/Rollup plugin, or a framework's SFC
 * compiler plugin (`@nifrajs/web-vue/plugin` and friends, which import the compiler). A relative
 * `./plugin` is NOT matched - a local file of that name is as likely to be the app's own tiny plugin as
 * a compiler, and this rule fails a gate.
 */
const DEV_TOOLCHAIN =
  /^vite$|^vite\/|^@vitejs\/|vite-plugin|^rollup$|^@rollup\/|^esbuild$|^(?:@[^/]+\/)?[^./][^/]*\/(?:.*\/)?plugin(?:\.ts)?$/

/** Specifiers that name the Vite pipeline outright. */
const VITE_SPECIFIER = /^vite$|^vite\/|^@vitejs\/|vite-plugin/
/** Specifiers whose package subpath is nifra's Bun-plugin convention (`@nifrajs/web-vue/plugin`). */
const BUN_SPECIFIER = /^(?:@[^/]+\/)?[^./][^/]*\/(?:.*\/)?plugin(?:\.ts)?$/

const lineAt = (src: string, index: number): number => {
  let line = 1
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === "\n") line++
  return line
}

/** Local binding names introduced by one import clause (`a`, `{ b as c }`, `* as ns`). */
function localNames(clause: string): string[] {
  const names: string[] = []
  const braced = /\{([^}]*)\}/.exec(clause)
  if (braced !== null) {
    for (const part of (braced[1] ?? "").split(",")) {
      const named = /([A-Za-z_$][\w$]*)\s*$/.exec(part.trim())
      if (named?.[1] !== undefined) names.push(named[1])
    }
  }
  const head = clause.replace(/\{[^}]*\}/, " ").replace(/,/g, " ")
  const star = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(head)
  if (star?.[1] !== undefined) names.push(star[1])
  else {
    const def = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(head)
    if (def?.[1] !== undefined) names.push(def[1])
  }
  return names
}

interface ImportedBinding {
  readonly specifier: string
  readonly index: number
}

/**
 * Every value-importing binding in a module, mapped to the specifier it came from. `import type` is
 * skipped: a type has no runtime cost, so it is neither a bundled toolchain nor a plugin in a slot.
 */
function importedBindings(stripped: string): Map<string, ImportedBinding> {
  const out = new Map<string, ImportedBinding>()
  const re = /(?<![.\w$])import\s+(?!type[\s{])([^'";]+?)\s+from\s*['"]([^'"]+)['"]/g
  for (let m = re.exec(stripped); m !== null; m = re.exec(stripped)) {
    const specifier = m[2]
    if (specifier === undefined) continue
    for (const name of localNames(m[1] ?? "")) out.set(name, { specifier, index: m.index })
  }
  return out
}

/** Every specifier a module imports for its side effects or bindings, with the position to report. */
function importedSpecifiers(stripped: string): Array<{ specifier: string; index: number }> {
  const out: Array<{ specifier: string; index: number }> = []
  const re = /(?<![.\w$])import\s+(?:(?!type[\s{])[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/g
  for (let m = re.exec(stripped); m !== null; m = re.exec(stripped)) {
    if (m[1] !== undefined) out.push({ specifier: m[1], index: m.index })
  }
  return out
}

/** Index just past the `]` matching the `[` at `open`, or `undefined` when it never closes. */
function closeBracket(masked: string, open: number): number | undefined {
  let depth = 0
  for (let i = open; i < masked.length; i++) {
    const c = masked[i]
    if (c === "[") depth++
    else if (c === "]") {
      depth--
      if (depth === 0) return i
    }
  }
  return undefined
}

interface SlotState {
  /** Whether the slot holds at least one plugin (an empty array literal reads as absent, as at runtime). */
  readonly present: boolean
  /** Whether the source states that outright, rather than deferring to a thunk or a re-export. */
  readonly certain: boolean
  readonly index?: number
  /** Identifiers inside the array literal, when there is one. */
  readonly items?: readonly string[]
}

const ABSENT: SlotState = { present: false, certain: true }

/**
 * Read one exported binding as a plugin slot.
 *
 * Only an array LITERAL is read precisely; a thunk (`() => import(…)`), a bare identifier or a
 * re-export is recorded as present-but-uncertain. That asymmetry is deliberate: `[]` and `[vue()]`
 * decide the pipeline, and anything else is a promise the source cannot keep.
 */
function readSlot(masked: string, stripped: string, name: string): SlotState {
  const declaration = new RegExp(
    `(?<![.\\w$])export\\s+(?:const|let|var)\\s+${name}\\b[^=\\n]*=\\s*`,
  )
  const m = declaration.exec(masked)
  if (m !== null) {
    const start = m.index + m[0].length
    if (masked[start] === "[") {
      const end = closeBracket(masked, start)
      if (end !== undefined) {
        // Both views are offset-preserving, and each answers a different question: the mask has string
        // CONTENTS blanked, so identifiers found in it are real code; the stripped source keeps them, so
        // it is the one that can tell `["solid"]` from `[]`.
        const code = masked.slice(start + 1, end)
        const text = stripped.slice(start + 1, end)
        const items = [...code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)].map((i) => i[1] ?? "")
        return { present: text.trim() !== "", certain: true, index: m.index, items }
      }
    }
    return { present: true, certain: false, index: m.index }
  }
  // `export { vitePlugins } from "./plugins.ts"` - present, but its contents live in another file.
  const reexport = new RegExp(`(?<![.\\w$])export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`)
  const r = reexport.exec(stripped)
  if (r !== null) return { present: true, certain: false, index: r.index }
  // `export * from …` could carry the slot; say so rather than reporting an absence that isn't one.
  if (/(?<![.\w$])export\s*\*\s*from/.test(stripped)) return { present: false, certain: false }
  return ABSENT
}

/** Which pipeline a plugin reference belongs to, or `undefined` when its name and origin say nothing. */
function classifyRef(name: string, specifier: string | undefined): BuildPipeline | undefined {
  // nifra's own Bun plugins are named for what they are, and the name survives an alias-free import.
  if (/BunPlugin$/.test(name)) return "bun"
  if (specifier === undefined) return undefined
  if (VITE_SPECIFIER.test(specifier)) return "vite"
  if (BUN_SPECIFIER.test(specifier)) return "bun"
  return undefined
}

/** Read one file as text, or `undefined` when it is missing or unreadable. */
async function readSource(path: string): Promise<string | undefined> {
  try {
    return await Bun.file(path).text()
  } catch {
    return undefined
  }
}

/**
 * Report the pipeline and its config hazards for the app at `cwd`, without executing anything.
 * Total: a missing or unreadable config yields `ran: false`, never a throw.
 */
export async function collectPipelineReport(cwd: string): Promise<PipelineReport> {
  const configFile = existsSync(join(cwd, "nifra.config.ts")) ? "nifra.config.ts" : "framework.ts"
  const source = await readSource(join(cwd, configFile))
  if (source === undefined) {
    return {
      ran: false,
      pipeline: "unknown",
      reason: "no nifra.config.ts or framework.ts here",
      certain: false,
      findings: [],
    }
  }
  const masked = codePositionMask(source)
  const stripped = stripComments(source)
  const bindings = importedBindings(stripped)
  const slots = Object.fromEntries(
    SLOTS.map((slot) => [slot, readSlot(masked, stripped, slot)]),
  ) as Record<Slot, SlotState>

  const findings: PipelineFinding[] = []

  // A plugin whose specifier names the other pipeline. The load-time guard classifies by hook shape and
  // remains the authority; this is the half of it that can run on a repo nobody has installed yet.
  for (const slot of SLOTS) {
    const state = slots[slot]
    const expected = SLOT_PIPELINE[slot]
    for (const item of state.items ?? []) {
      const binding = bindings.get(item)
      const actual = classifyRef(item, binding?.specifier)
      if (actual === undefined || actual === expected) continue
      const from = binding !== undefined ? ` (imported from "${binding.specifier}")` : ""
      findings.push({
        rule: "plugin-slot",
        severity: "error",
        file: configFile,
        line: lineAt(source, state.index ?? 0),
        message:
          `\`${item}\`${from} is a ${actual === "vite" ? "Vite" : "Bun"} plugin but sits in \`${slot}\`, which feeds ` +
          `${expected === "vite" ? "Vite" : "Bun.build"}. The wrong bundler never calls its hooks, so the transform silently does not run and the build still succeeds.`,
        fix:
          actual === "vite"
            ? `move \`${item}\` to \`vitePlugins\``
            : `move \`${item}\` to \`clientPlugins\` (client bundle) or \`serverPlugins\` (SSR)`,
      })
    }
  }

  // Which bundler this app gets, by the same rule `chooseBuildPipeline` applies to the loaded config.
  const viteOnly =
    slots.vitePlugins.present && !slots.clientPlugins.present && !slots.serverPlugins.present
  const certain = SLOTS.every((slot) => slots[slot].certain)
  const pipeline: BuildPipeline = viteOnly ? "vite" : "bun"
  const reason = viteOnly
    ? "auto: this app's only transforms are `vitePlugins`, which the Bun build cannot run"
    : slots.clientPlugins.present || slots.serverPlugins.present
      ? "default: this app declares Bun plugins, so both phases stay on Bun"
      : "default: no transforms to place, so both phases stay on Bun"

  // The adapter entry is bundled into every `nifra build` server entry. Whatever it imports goes with it.
  const adapterEntry = existsSync(join(cwd, "framework.ts")) ? "framework.ts" : configFile
  const entrySource =
    adapterEntry === configFile ? source : await readSource(join(cwd, adapterEntry))
  if (entrySource !== undefined) {
    const seen = new Set<string>()
    for (const { specifier, index } of importedSpecifiers(stripComments(entrySource))) {
      if (!DEV_TOOLCHAIN.test(specifier) || seen.has(specifier)) continue
      seen.add(specifier)
      findings.push({
        rule: "adapter-entry",
        severity: "error",
        file: adapterEntry,
        line: lineAt(entrySource, index),
        message:
          `${adapterEntry} imports "${specifier}", and \`nifra build\` imports the adapter from ${adapterEntry} - ` +
          "so the dev toolchain is bundled into the production server entry. The build succeeds and the server then fails at startup on a dependency of the bundler (a missing native binding, typically), which reads like a broken install rather than a config split.",
        fix:
          adapterEntry === "framework.ts"
            ? 'move "' +
              specifier +
              '" to `nifra.config.ts`, which only the CLI imports, and keep `framework.ts` to the adapter'
            : 'add a `framework.ts` exporting just the adapter, re-export it from `nifra.config.ts` (`export { adapter } from "./framework"`), and leave the toolchain imports in the config',
      })
    }
  }

  // `conditions` reach SSR on the Bun pipeline and cannot reach the client bundle Bun's dev server
  // serves - it takes no resolve conditions from bunfig or anywhere else. `nifra dev` says so at
  // startup; a project whose CI only runs `nifra check` would otherwise never hear it.
  const conditions = readSlot(masked, stripped, "conditions")
  if (conditions.present && pipeline === "bun") {
    findings.push({
      rule: "bun-client-conditions",
      severity: "warning",
      file: configFile,
      line: lineAt(source, conditions.index ?? 0),
      message:
        "`conditions` are honoured by SSR and by `nifra build`, but Bun's dev-server bundler accepts no resolve conditions - so under `nifra dev` a package with an `exports` map can resolve to one file in the browser and another everywhere else.",
      fix: "run `nifra dev --vite` when the client bundle must resolve exactly as production does",
    })
  }

  return {
    ran: true,
    pipeline: certain ? pipeline : "unknown",
    reason: certain
      ? reason
      : "the config states its plugins indirectly (a thunk, an identifier or a re-export), so the bundler can only be read by loading it - `nifra dev` and `nifra build` print the real one",
    certain,
    configFile,
    adapterEntry,
    findings,
  }
}
