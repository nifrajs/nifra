/**
 * The public command contract for the stable, project-facing nifra commands.
 *
 * This module is deliberately descriptive at the projection boundary: the catalog entry does not run
 * a command, validate permissions, or decide whether a result is safe. Those policies remain in the
 * command implementations and in the adapters (the same split used by `@nifrajs/core/tool-catalog`).
 */

import { resolve } from "node:path"
import { formatAssuranceReport } from "./assure.ts"
import type {
  CapabilityCheckCommandResult,
  CapabilityExplainCommandResult,
  CapabilitySnapshotCommandResult,
} from "./capabilities-tool.ts"
import { type CheckResult, renderCheckReport } from "./check.ts"
import type { ContractsLock } from "./contracts.ts"
import type { DoctorResult } from "./doctor.ts"
import type { VerificationLevelsResult } from "./levels-tool.ts"
import type { LoadedApp } from "./load.ts"
import type { ManifestEmitCommandResult } from "./manifest-tool.ts"
import { collectPortResult, type PortResult, renderReport } from "./port.ts"
import type { ReplayResult } from "./replay.ts"
import type { StylexMigrationResult } from "./stylex-migrate.ts"
import {
  collectProjectWorkGraph,
  type ProjectWorkGraphResult,
  renderWorkGraphText,
} from "./work-graph.ts"

export type CommandTransport = "cli" | "mcp"
export type CommandStability = "stable" | "experimental"
export type CommandJsonSchema = Readonly<Record<string, unknown>>

export interface CommandInputSchema<Input> {
  readonly jsonSchema: CommandJsonSchema
  readonly parse: (value: unknown) => Input
}

export interface CommandOutputContract<Output> {
  /** Increment when the structured result changes incompatibly. */
  readonly version: number
  readonly jsonSchema: CommandJsonSchema
  /** Accepts the current result and, where possible, the prior un-enveloped result shape. */
  readonly parse: (value: unknown) => Output
}

export type CommandFlagType = "boolean" | "string" | "number" | "string[]"

export interface CommandFlag<Input> {
  readonly name: string
  readonly field: keyof Input & string
  readonly type: CommandFlagType
  readonly aliases?: readonly string[]
}

/** The small CLI-only binding layer between argv and the same JSON input object MCP receives. */
export interface CommandArgvBinding<Input> {
  readonly positionals?: readonly (keyof Input & string)[]
  readonly flags?: readonly CommandFlag<Input>[]
}

export interface CommandCtx {
  readonly cwd: string
  readonly signal?: AbortSignal
  readonly progress?: (message: string) => void
  readonly cliVersion?: string
  /** Adapter-provided cache for commands that need the loaded web app. */
  readonly loadApp?: () => Promise<LoadedApp>
}

export interface CommandSpec<Input, Output> {
  readonly name: string
  readonly summary: string
  readonly input: CommandInputSchema<Input>
  readonly output: CommandOutputContract<Output>
  readonly transports: readonly CommandTransport[]
  readonly stability: CommandStability
  readonly argv?: CommandArgvBinding<Input>
  readonly run: (input: Input, ctx: CommandCtx) => Promise<Output>
  readonly render: (out: Output, input?: Input) => readonly string[]
  readonly success?: (out: Output, input: Input) => boolean
  /** JSON-compatible view. Defaults to the raw command result. */
  readonly json?: (out: Output, input: Input) => unknown
}

export interface CommandCatalogEntry {
  readonly name: string
  readonly summary: string
  readonly inputSchema: CommandJsonSchema
  readonly outputVersion: number
  readonly transports: readonly CommandTransport[]
  readonly stability: CommandStability
}

function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeJson(child)
    Object.freeze(value)
  }
  return value
}

/** Build the single descriptive projection shared by CLI help, MCP tools, and generated cards. */
export function toCommandCatalogEntry<Input, Output>(
  spec: CommandSpec<Input, Output>,
): CommandCatalogEntry {
  return Object.freeze({
    name: spec.name,
    summary: spec.summary,
    inputSchema: freezeJson({ ...spec.input.jsonSchema }),
    outputVersion: spec.output.version,
    transports: Object.freeze([...spec.transports]),
    stability: spec.stability,
  })
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("command input must be an object")
  return value as Record<string, unknown>
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`)
  return value
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "boolean") throw new TypeError(`${field} must be a boolean`)
  return value
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new TypeError(`${field} must be a finite number`)
  return value
}

function objectSchema(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): CommandJsonSchema {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

function input<Input>(
  jsonSchema: CommandJsonSchema,
  parse: (value: unknown) => Input,
): CommandInputSchema<Input> {
  return Object.freeze({ jsonSchema: freezeJson({ ...jsonSchema }), parse })
}

function output<Output>(
  jsonSchema: CommandJsonSchema,
  parse: (value: unknown) => Output = (value) => value as Output,
): CommandOutputContract<Output> {
  return Object.freeze({ version: 1, jsonSchema: freezeJson({ ...jsonSchema }), parse })
}

function withDir<T extends Record<string, unknown>>(value: T): T & { dir?: string } {
  const raw = record(value)
  const dir = optionalString(raw.dir, "dir")
  return { ...(value as T), ...(dir === undefined ? {} : { dir }) }
}

function valueAfterFlag(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith("-")) throw new Error(`${flag} needs a value`)
  return value
}

/** Bind CLI positionals and flags to the JSON object passed to a command's schema parser. */
export function bindCommandArgv<Input, Output>(
  spec: CommandSpec<Input, Output>,
  argv: readonly string[],
): Input {
  const raw: Record<string, unknown> = {}
  const binding = spec.argv
  const flags = binding?.flags ?? []
  const byName = new Map<string, CommandFlag<Input>>()
  for (const flag of flags) {
    byName.set(`--${flag.name}`, flag)
    for (const alias of flag.aliases ?? []) byName.set(alias, flag)
  }
  const positionals = binding?.positionals ?? []
  let positionalIndex = 0
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (token.startsWith("-")) {
      const equals = token.indexOf("=")
      const flagName = equals === -1 ? token : token.slice(0, equals)
      const flag = byName.get(flagName)
      if (flag === undefined) throw new Error(`unknown option: ${token}`)
      if (flag.type === "boolean") {
        const value = equals === -1 ? undefined : token.slice(equals + 1)
        if (value !== undefined && value !== "true" && value !== "false")
          throw new Error(`${flagName} must be a boolean`)
        raw[flag.field] = value !== "false"
      } else {
        const value =
          equals === -1 ? valueAfterFlag(argv, index, flagName) : token.slice(equals + 1)
        if (equals === -1) index++
        if (flag.type === "number") {
          const number = Number(value)
          if (!Number.isFinite(number)) throw new Error(`${flagName} must be a number`)
          raw[flag.field] = number
        } else if (flag.type === "string[]") {
          const values = (raw[flag.field] as string[] | undefined) ?? []
          values.push(value)
          raw[flag.field] = values
        } else raw[flag.field] = value
      }
      continue
    }
    const field = positionals[positionalIndex++]
    if (field === undefined) throw new Error(`unexpected positional argument: ${token}`)
    raw[field] = token
  }
  return spec.input.parse(raw)
}

function parseBooleanFlags(
  raw: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of fields) out[field] = optionalBoolean(raw[field], field)
  return out
}

interface CheckInput {
  readonly lintsOnly?: boolean | undefined
  readonly json?: boolean | undefined
  readonly maxDiagnostics?: number | undefined
  readonly dir?: string | undefined
}

interface AssureInput {
  readonly config?: string | undefined
  readonly bundle?: boolean | undefined
  readonly strict?: boolean | undefined
  readonly hydration?: boolean | undefined
  readonly interact?: boolean | undefined
  readonly out?: string | undefined
  readonly json?: boolean | undefined
  readonly dir?: string | undefined
}

interface LevelsInput {
  readonly config?: string | undefined
  readonly seed?: number | undefined
  readonly min?: number | undefined
  readonly json?: boolean | undefined
  readonly dir?: string | undefined
}

interface CapabilitiesInput {
  readonly action: "snapshot" | "check" | "explain"
  readonly config?: string | undefined
  readonly out?: string | undefined
  readonly lockfile?: string | undefined
  readonly method?: string | undefined
  readonly path?: string | undefined
  readonly json?: boolean | undefined
  readonly dir?: string | undefined
}

interface ManifestInput {
  readonly action: "emit" | "diff"
  readonly config?: string | undefined
  readonly out?: string | undefined
  readonly sign?: string | undefined
  readonly before?: string | undefined
  readonly after?: string | undefined
  readonly json?: boolean | undefined
  readonly dir?: string | undefined
}

interface RoutesInput {
  readonly json?: boolean | undefined
  readonly graph?: boolean | undefined
  readonly modes?: boolean | undefined
  readonly target?: string | undefined
  readonly dir?: string | undefined
}

interface ContextInput {
  readonly path?: string | undefined
  readonly kind?: "api" | "pages" | undefined
  readonly dir?: string | undefined
}

interface OpenApiInput {
  readonly format?: "json" | "yaml" | undefined
  readonly path?: string | undefined
  readonly dir?: string | undefined
}

interface DoctorInput {
  readonly json?: boolean | undefined
  readonly autoFix?: boolean | undefined
  readonly strict?: boolean | undefined
  readonly target?: string | undefined
  readonly dir?: string | undefined
}

interface FixInput {
  readonly code?: string | undefined
  readonly json?: boolean | undefined
  readonly dir?: string | undefined
}

interface MigrateInput {
  readonly from: "tailwind"
  readonly to: "stylex"
  readonly write?: boolean | undefined
  readonly json?: boolean | undefined
  readonly dir?: string | undefined
}

interface SnapshotInput {
  readonly out?: string | undefined
  readonly json?: boolean | undefined
  readonly dir?: string | undefined
}

interface DiffInput {
  readonly baseline?: string | undefined
  readonly json?: boolean | undefined
  readonly dir?: string | undefined
}

interface ContractsInput {
  readonly action: "snapshot" | "check"
  readonly out?: string | undefined
  readonly json?: boolean | undefined
  readonly dir?: string | undefined
}

interface SyncInput {
  readonly json?: boolean | undefined
  readonly dir?: string | undefined
}

interface ProveInput {
  readonly files?: readonly string[] | undefined
  readonly minLevel?: number | undefined
  readonly json?: boolean | undefined
  readonly dir?: string | undefined
}

interface ReplayInput {
  readonly file: string
  readonly dir?: string | undefined
}

interface PortInput {
  readonly target?: string | undefined
  readonly json?: boolean | undefined
  readonly ci?: boolean | undefined
  readonly strict?: boolean | undefined
  readonly dir?: string | undefined
}

interface CheckCommandOutput extends CheckResult {}
interface AssureCommandOutput {
  readonly report?: unknown
  readonly bundle?: unknown
  readonly ok: boolean
}
interface LevelsCommandOutput extends VerificationLevelsResult {}
interface RoutesCommandOutput {
  readonly ok: boolean
  readonly mode: "default" | "graph" | "modes"
  readonly data: unknown
  readonly text: string
}
interface ContextCommandOutput {
  readonly ok: true
  readonly text: string
}
interface OpenApiCommandOutput {
  readonly ok: true
  readonly format: "json" | "yaml"
  readonly text: string
}
interface FixCommandOutput {
  readonly ok: boolean
  readonly changed: readonly string[]
  /** Recipes that refused, with the reason. A recipe that cannot act says so here instead of
   * aborting the run or - worse - reporting nothing at all. */
  readonly failed: readonly { readonly code: string; readonly reason: string }[]
  readonly diagnostics: readonly unknown[]
}
interface MigrateCommandOutput extends StylexMigrationResult {}
interface SnapshotCommandOutput {
  readonly ok: true
  readonly file: string
  readonly routes: number
  readonly snapshot: unknown
}
interface DiffCommandOutput {
  readonly ok: boolean
  readonly hasBreaking: boolean
  readonly changes: readonly unknown[]
}
interface ContractsCommandOutput {
  readonly ok: boolean
  readonly lock?: ContractsLock
  readonly diagnostics?: readonly unknown[]
  readonly present?: boolean
  readonly vacuous?: boolean
}
interface SyncCommandOutput {
  readonly ok: true
  readonly results: readonly unknown[]
}

const CHECK_SCHEMA = input<CheckInput>(
  objectSchema({
    lintsOnly: { type: "boolean" },
    json: { type: "boolean" },
    maxDiagnostics: { type: "integer", minimum: 1 },
    dir: { type: "string" },
  }),
  (value) => {
    const raw = withDir(record(value))
    const maxDiagnostics = optionalNumber(raw.maxDiagnostics, "maxDiagnostics")
    if (maxDiagnostics !== undefined && (!Number.isInteger(maxDiagnostics) || maxDiagnostics < 1))
      throw new TypeError("maxDiagnostics must be a positive integer")
    return {
      ...parseBooleanFlags(raw, ["lintsOnly", "json"]),
      ...(maxDiagnostics === undefined ? {} : { maxDiagnostics }),
      ...(raw.dir === undefined ? {} : { dir: raw.dir }),
    } as CheckInput
  },
)

const ASSURE_SCHEMA = input<AssureInput>(
  objectSchema({
    config: { type: "string" },
    bundle: { type: "boolean" },
    strict: { type: "boolean" },
    hydration: { type: "boolean" },
    interact: { type: "boolean" },
    out: { type: "string" },
    json: { type: "boolean" },
    dir: { type: "string" },
  }),
  (value) => {
    const raw = withDir(record(value))
    return {
      ...parseBooleanFlags(raw, ["bundle", "strict", "hydration", "interact", "json"]),
      config: optionalString(raw.config, "config"),
      out: optionalString(raw.out, "out"),
      ...(raw.dir === undefined ? {} : { dir: raw.dir }),
    }
  },
)

const LEVELS_SCHEMA = input<LevelsInput>(
  objectSchema({
    config: { type: "string" },
    seed: { type: "number" },
    min: { type: "integer", minimum: 0, maximum: 4 },
    json: { type: "boolean" },
    dir: { type: "string" },
  }),
  (value) => {
    const raw = withDir(record(value))
    const seed = optionalNumber(raw.seed, "seed")
    const min = optionalNumber(raw.min, "min")
    if (seed !== undefined && !Number.isSafeInteger(seed))
      throw new TypeError("seed must be a safe integer")
    if (min !== undefined && (!Number.isInteger(min) || min < 0 || min > 4))
      throw new TypeError("min must be an integer from 0 to 4")
    return {
      ...parseBooleanFlags(raw, ["json"]),
      config: optionalString(raw.config, "config"),
      ...(seed === undefined ? {} : { seed }),
      ...(min === undefined ? {} : { min }),
      ...(raw.dir === undefined ? {} : { dir: raw.dir }),
    }
  },
)

const CAPABILITIES_SCHEMA = input<CapabilitiesInput>(
  objectSchema(
    {
      action: { type: "string", enum: ["snapshot", "check", "explain"] },
      config: { type: "string" },
      out: { type: "string" },
      lockfile: { type: "string" },
      method: { type: "string" },
      path: { type: "string" },
      json: { type: "boolean" },
      dir: { type: "string" },
    },
    ["action"],
  ),
  (value) => {
    const raw = withDir(record(value))
    if (raw.action !== "snapshot" && raw.action !== "check" && raw.action !== "explain")
      throw new TypeError("action must be snapshot, check, or explain")
    return {
      action: raw.action,
      config: optionalString(raw.config, "config"),
      out: optionalString(raw.out, "out"),
      lockfile: optionalString(raw.lockfile, "lockfile"),
      method: optionalString(raw.method, "method"),
      path: optionalString(raw.path, "path"),
      ...parseBooleanFlags(raw, ["json"]),
      ...(raw.dir === undefined ? {} : { dir: raw.dir }),
    }
  },
)

const MANIFEST_SCHEMA = input<ManifestInput>(
  objectSchema(
    {
      action: { type: "string", enum: ["emit", "diff"] },
      config: { type: "string" },
      out: { type: "string" },
      sign: { type: "string" },
      before: { type: "string" },
      after: { type: "string" },
      json: { type: "boolean" },
      dir: { type: "string" },
    },
    ["action"],
  ),
  (value) => {
    const raw = withDir(record(value))
    if (raw.action !== "emit" && raw.action !== "diff")
      throw new TypeError("action must be emit or diff")
    return {
      action: raw.action,
      config: optionalString(raw.config, "config"),
      out: optionalString(raw.out, "out"),
      sign: optionalString(raw.sign, "sign"),
      before: optionalString(raw.before, "before"),
      after: optionalString(raw.after, "after"),
      ...parseBooleanFlags(raw, ["json"]),
      ...(raw.dir === undefined ? {} : { dir: raw.dir }),
    }
  },
)

const ROUTES_SCHEMA = input<RoutesInput>(
  objectSchema({
    json: { type: "boolean" },
    graph: { type: "boolean" },
    modes: { type: "boolean" },
    target: { type: "string" },
    dir: { type: "string" },
  }),
  (value) => {
    const raw = withDir(record(value))
    if (raw.graph === true && raw.modes === true)
      throw new TypeError("graph and modes cannot be combined")
    return {
      ...parseBooleanFlags(raw, ["json", "graph", "modes"]),
      target: optionalString(raw.target, "target"),
      ...(raw.dir === undefined ? {} : { dir: raw.dir }),
    }
  },
)

const CONTEXT_SCHEMA = input<ContextInput>(
  objectSchema({
    path: { type: "string" },
    kind: { type: "string", enum: ["api", "pages"] },
    dir: { type: "string" },
  }),
  (value) => {
    const raw = withDir(record(value))
    if (raw.kind !== undefined && raw.kind !== "api" && raw.kind !== "pages")
      throw new TypeError("kind must be api or pages")
    return {
      path: optionalString(raw.path, "path"),
      kind: raw.kind as "api" | "pages" | undefined,
      ...(raw.dir === undefined ? {} : { dir: raw.dir }),
    }
  },
)

const OPENAPI_SCHEMA = input<OpenApiInput>(
  objectSchema({
    format: { type: "string", enum: ["json", "yaml"] },
    path: { type: "string" },
    dir: { type: "string" },
  }),
  (value) => {
    const raw = withDir(record(value))
    if (raw.format !== undefined && raw.format !== "json" && raw.format !== "yaml")
      throw new TypeError("format must be json or yaml")
    return {
      format: (raw.format ?? "json") as "json" | "yaml",
      path: optionalString(raw.path, "path"),
      ...(raw.dir === undefined ? {} : { dir: raw.dir }),
    }
  },
)

const DOCTOR_SCHEMA = input<DoctorInput>(
  objectSchema({
    json: { type: "boolean" },
    autoFix: { type: "boolean" },
    strict: { type: "boolean" },
    target: { type: "string" },
    dir: { type: "string" },
  }),
  (value) => {
    const raw = withDir(record(value))
    return {
      ...parseBooleanFlags(raw, ["json", "autoFix", "strict"]),
      target: optionalString(raw.target, "target"),
      ...(raw.dir === undefined ? {} : { dir: raw.dir }),
    }
  },
)

const FIX_SCHEMA = input<FixInput>(
  objectSchema({ code: { type: "string" }, json: { type: "boolean" }, dir: { type: "string" } }),
  (value) => {
    const raw = withDir(record(value))
    return {
      code: optionalString(raw.code, "code"),
      ...parseBooleanFlags(raw, ["json"]),
      ...(raw.dir === undefined ? {} : { dir: raw.dir }),
    }
  },
)

const MIGRATE_SCHEMA = input<MigrateInput>(
  objectSchema(
    {
      from: { type: "string", enum: ["tailwind"] },
      to: { type: "string", enum: ["stylex"] },
      write: { type: "boolean" },
      json: { type: "boolean" },
      dir: { type: "string" },
    },
    ["from", "to"],
  ),
  (value) => {
    const raw = withDir(record(value))
    const from = optionalString(raw.from, "from")
    const to = optionalString(raw.to, "to")
    if (from !== "tailwind") throw new TypeError("from must be tailwind")
    if (to !== "stylex") throw new TypeError("to must be stylex")
    return {
      from,
      to,
      ...parseBooleanFlags(raw, ["write", "json"]),
      ...(raw.dir === undefined ? {} : { dir: raw.dir }),
    }
  },
)

const SNAPSHOT_SCHEMA = input<SnapshotInput>(
  objectSchema({ out: { type: "string" }, json: { type: "boolean" }, dir: { type: "string" } }),
  (value) => {
    const raw = withDir(record(value))
    return {
      out: optionalString(raw.out, "out"),
      ...parseBooleanFlags(raw, ["json"]),
      ...(raw.dir === undefined ? {} : { dir: raw.dir }),
    }
  },
)

const DIFF_SCHEMA = input<DiffInput>(
  objectSchema({
    baseline: { type: "string" },
    json: { type: "boolean" },
    dir: { type: "string" },
  }),
  (value) => {
    const raw = withDir(record(value))
    return {
      baseline: optionalString(raw.baseline, "baseline"),
      ...parseBooleanFlags(raw, ["json"]),
      ...(raw.dir === undefined ? {} : { dir: raw.dir }),
    }
  },
)

const CONTRACTS_SCHEMA = input<ContractsInput>(
  objectSchema(
    {
      action: { type: "string", enum: ["snapshot", "check"] },
      out: { type: "string" },
      json: { type: "boolean" },
      dir: { type: "string" },
    },
    ["action"],
  ),
  (value) => {
    const raw = withDir(record(value))
    if (raw.action !== "snapshot" && raw.action !== "check")
      throw new TypeError("action must be snapshot or check")
    return {
      action: raw.action,
      out: optionalString(raw.out, "out"),
      ...parseBooleanFlags(raw, ["json"]),
      ...(raw.dir === undefined ? {} : { dir: raw.dir }),
    }
  },
)

const SYNC_SCHEMA = input<SyncInput>(
  objectSchema({ json: { type: "boolean" }, dir: { type: "string" } }),
  (value) => {
    const raw = withDir(record(value))
    return {
      ...parseBooleanFlags(raw, ["json"]),
      ...(raw.dir === undefined ? {} : { dir: raw.dir }),
    }
  },
)

const PROVE_SCHEMA = input<ProveInput>(
  objectSchema({
    files: { type: "array", items: { type: "string" } },
    minLevel: { type: "integer", minimum: 0, maximum: 4 },
    json: { type: "boolean" },
    dir: { type: "string" },
  }),
  (value) => {
    const raw = withDir(record(value))
    let files: readonly string[] | undefined
    if (raw.files !== undefined) {
      if (!Array.isArray(raw.files) || raw.files.some((entry) => typeof entry !== "string"))
        throw new TypeError("files must be an array of strings")
      files = raw.files as readonly string[]
    }
    const minLevel = optionalNumber(raw.minLevel, "minLevel")
    if (minLevel !== undefined && (!Number.isInteger(minLevel) || minLevel < 0 || minLevel > 4))
      throw new TypeError("minLevel must be an integer from 0 to 4")
    return {
      ...(files === undefined ? {} : { files }),
      ...(minLevel === undefined ? {} : { minLevel }),
      ...parseBooleanFlags(raw, ["json"]),
      ...(raw.dir === undefined ? {} : { dir: raw.dir }),
    }
  },
)

const REPLAY_SCHEMA = input<ReplayInput>(
  objectSchema({ file: { type: "string" }, dir: { type: "string" } }, ["file"]),
  (value) => {
    const raw = withDir(record(value))
    const file = optionalString(raw.file, "file")
    if (file === undefined || file.trim() === "") throw new TypeError("file is required")
    return { file, ...(raw.dir === undefined ? {} : { dir: raw.dir }) }
  },
)

const PORT_SCHEMA = input<PortInput>(
  objectSchema({
    target: { type: "string" },
    json: { type: "boolean" },
    ci: { type: "boolean" },
    strict: { type: "boolean" },
    dir: { type: "string" },
  }),
  (value) => {
    const raw = withDir(record(value))
    return {
      target: optionalString(raw.target, "target"),
      ...parseBooleanFlags(raw, ["json", "ci", "strict"]),
      ...(raw.dir === undefined ? {} : { dir: raw.dir }),
    }
  },
)

function loadAppFor(ctx: CommandCtx): Promise<LoadedApp> {
  if (ctx.loadApp !== undefined) return ctx.loadApp()
  return import("./load.ts").then(({ loadApp }) => loadApp(ctx.cwd))
}

function checkJson(out: CheckCommandOutput): unknown {
  return out.structuredDiagnostics === undefined
    ? out
    : { ...out, diagnostics: out.structuredDiagnostics }
}

const checkSpec: CommandSpec<CheckInput, CheckCommandOutput> = {
  name: "check",
  summary: "Run the typed-contract, source-lint, and dependency drift gate.",
  input: CHECK_SCHEMA,
  output: output<CheckCommandOutput>({
    type: "object",
    properties: { ok: { type: "boolean" }, diagnostics: { type: "array" } },
    required: ["ok", "diagnostics"],
  }),
  transports: ["cli", "mcp"],
  stability: "stable",
  argv: {
    flags: [
      { name: "lints-only", field: "lintsOnly", type: "boolean" },
      { name: "json", field: "json", type: "boolean" },
    ],
  },
  async run(value, ctx) {
    const { collectProjectVerification } = await import("./verification.ts")
    return (
      await collectProjectVerification(ctx.cwd, {
        lintsOnly: value.lintsOnly === true,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        ...(value.maxDiagnostics === undefined ? {} : { maxDiagnostics: value.maxDiagnostics }),
      })
    ).check()
  },
  render: (out) => renderCheckReport(out),
  success: (out) => out.ok,
  json: (out) => checkJson(out),
}

const assureSpec: CommandSpec<AssureInput, AssureCommandOutput> = {
  name: "assure",
  summary: "Evaluate route classification and fail-closed enforcement evidence.",
  input: ASSURE_SCHEMA,
  output: output({ type: "object" }),
  transports: ["cli", "mcp"],
  stability: "stable",
  argv: {
    flags: [
      { name: "config", field: "config", type: "string" },
      { name: "out", field: "out", type: "string" },
      { name: "json", field: "json", type: "boolean" },
      { name: "bundle", field: "bundle", type: "boolean" },
      { name: "strict", field: "strict", type: "boolean" },
      { name: "hydration", field: "hydration", type: "boolean" },
      { name: "interact", field: "interact", type: "boolean" },
    ],
  },
  async run(value, ctx) {
    const { collectAssuranceReport, collectAssureBundle } = await import("./assure.ts")
    const bundle =
      value.bundle === true ||
      value.strict === true ||
      value.hydration === true ||
      value.interact === true
    if (bundle) {
      const result = await collectAssureBundle(ctx.cwd, {
        ...(value.config === undefined ? {} : { config: value.config }),
        ...(value.strict === undefined ? {} : { strict: value.strict }),
        ...(value.hydration === undefined ? {} : { hydration: value.hydration }),
        ...(value.interact === undefined ? {} : { interact: value.interact }),
      })
      if (value.out !== undefined)
        await Bun.write(resolve(ctx.cwd, value.out), `${JSON.stringify(result, null, 2)}\n`)
      return { bundle: result, ok: result.verdict === "green" }
    }
    const report = await collectAssuranceReport(ctx.cwd, value.config)
    return { report, ok: report.ok }
  },
  render: (out) => [
    out.bundle === undefined
      ? formatAssuranceReport(out.report as never)
      : JSON.stringify(out.bundle, null, 2),
  ],
  success: (out) => out.ok,
  json: (out) => out.bundle ?? out.report,
}

const levelsSpec: CommandSpec<LevelsInput, LevelsCommandOutput> = {
  name: "levels",
  summary: "Compute the cumulative L0 typed-contract through L4 invariant verification ladder.",
  input: LEVELS_SCHEMA,
  output: output({
    type: "object",
    properties: { achieved: { type: "integer" }, levels: { type: "array" } },
    required: ["achieved", "levels"],
  }),
  transports: ["cli", "mcp"],
  stability: "stable",
  argv: {
    flags: [
      { name: "config", field: "config", type: "string" },
      { name: "seed", field: "seed", type: "number" },
      { name: "min", field: "min", type: "number" },
      { name: "json", field: "json", type: "boolean" },
    ],
  },
  async run(value, ctx) {
    return import("./levels-tool.ts").then(({ collectVerificationLevels }) =>
      collectVerificationLevels(ctx.cwd, {
        ...(value.config === undefined ? {} : { config: value.config }),
        ...(value.seed === undefined ? {} : { seed: value.seed }),
      }),
    )
  },
  render: (out) => [
    ...out.levels.flatMap((s) => [
      `${s.ok ? "✓" : "✖"} L${s.level} ${s.name}`,
      ...s.reasons.map((r) => `    - ${r}`),
    ]),
    out.achieved < 0
      ? "[nifra] verification level: none (L0 failing)"
      : `[nifra] verification level: L${out.achieved}`,
  ],
  success: (out, value) => out.achieved >= (value.min ?? 0),
}

const capabilitiesSpec: CommandSpec<
  CapabilitiesInput,
  CapabilitySnapshotCommandResult | CapabilityCheckCommandResult | CapabilityExplainCommandResult
> = {
  name: "capabilities",
  summary: "Snapshot, check, or explain token-only capability provenance and lockfile drift.",
  input: CAPABILITIES_SCHEMA,
  output: output({ type: "object" }),
  transports: ["cli", "mcp"],
  stability: "stable",
  argv: {
    positionals: ["action", "method", "path"],
    flags: [
      { name: "config", field: "config", type: "string" },
      { name: "out", field: "out", type: "string" },
      { name: "lockfile", field: "lockfile", type: "string" },
      { name: "json", field: "json", type: "boolean" },
    ],
  },
  async run(value, ctx) {
    if (value.action === "snapshot")
      return import("./capabilities-tool.ts").then(({ collectCapabilitySnapshot }) =>
        collectCapabilitySnapshot(ctx.cwd, {
          ...(value.config === undefined ? {} : { config: value.config }),
          ...(value.out === undefined ? {} : { out: value.out }),
        }),
      )
    if (value.action === "check")
      return import("./capabilities-tool.ts").then(({ collectCapabilityCheck }) =>
        collectCapabilityCheck(ctx.cwd, {
          ...(value.config === undefined ? {} : { config: value.config }),
          ...(value.lockfile === undefined ? {} : { lockfile: value.lockfile }),
        }),
      )
    if (value.method === undefined || value.path === undefined)
      throw new Error("capabilities explain needs <METHOD> <path>")
    return import("./capabilities-tool.ts").then(({ collectCapabilityExplanation }) =>
      collectCapabilityExplanation(
        ctx.cwd,
        value.method!,
        value.path!,
        value.config === undefined ? {} : { config: value.config },
      ),
    )
  },
  render: (out) => [JSON.stringify(out, null, 2)],
  success: (out) => out.ok,
}

const manifestSpec: CommandSpec<ManifestInput, ManifestEmitCommandResult | DiffCommandOutput> = {
  name: "manifest",
  summary: "Emit or diff the hash-verified route trust manifest.",
  input: MANIFEST_SCHEMA,
  output: output({ type: "object" }),
  transports: ["cli", "mcp"],
  stability: "stable",
  argv: {
    positionals: ["action", "before", "after"],
    flags: [
      { name: "config", field: "config", type: "string" },
      { name: "out", field: "out", type: "string" },
      { name: "sign", field: "sign", type: "string" },
      { name: "json", field: "json", type: "boolean" },
    ],
  },
  async run(value, ctx) {
    if (value.action === "emit")
      return import("./manifest-tool.ts").then(({ collectManifestEmit }) =>
        collectManifestEmit(ctx.cwd, {
          ...(value.config === undefined ? {} : { config: value.config }),
          ...(value.out === undefined ? {} : { out: value.out }),
          ...(value.sign === undefined ? {} : { sign: value.sign }),
        }),
      )
    if (value.before === undefined || value.after === undefined)
      throw new Error("manifest diff needs <before> <after>")
    const diff = await import("./manifest-tool.ts").then(({ collectManifestDiff }) =>
      collectManifestDiff(ctx.cwd, value.before!, value.after!),
    )
    return { ok: !diff.hasBreaking, hasBreaking: diff.hasBreaking, changes: diff.changes }
  },
  render: (out) =>
    "changes" in out
      ? [
          out.ok ? "✓ no breaking manifest changes" : "✖ breaking manifest changes",
          ...(out.changes as readonly { method: string; path: string; message: string }[]).map(
            (c) => `${c.method} ${c.path}: ${c.message}`,
          ),
        ]
      : [
          out.ok
            ? `✓ wrote manifest to ${out.path}`
            : "✖ refusing to emit a manifest from failing assurance",
        ],
  success: (out) => out.ok,
  json: (out) => out,
}

const routesSpec: CommandSpec<RoutesInput, RoutesCommandOutput> = {
  name: "routes",
  summary: "List, graph, or target-check every page and API route the app serves.",
  input: ROUTES_SCHEMA,
  output: output({
    type: "object",
    properties: { ok: { type: "boolean" }, mode: { type: "string" }, data: {} },
    required: ["ok", "mode", "data"],
  }),
  transports: ["cli", "mcp"],
  stability: "stable",
  argv: {
    flags: [
      { name: "json", field: "json", type: "boolean" },
      { name: "graph", field: "graph", type: "boolean" },
      { name: "modes", field: "modes", type: "boolean" },
      { name: "target", field: "target", type: "string" },
    ],
  },
  async run(value, ctx) {
    const app = await loadAppFor(ctx)
    if (value.modes === true) {
      const { buildRouteManifest, renderRouteManifest } = await import(
        "@nifrajs/web/route-manifest"
      )
      const { discoverRoutes } = await import("@nifrajs/web/fs")
      const data = await buildRouteManifest(
        discoverRoutes(app.routesDir),
        value.target === undefined ? {} : { target: value.target },
      )
      return {
        ok: data.conflicts.length === 0,
        mode: "modes",
        data,
        text: renderRouteManifest(data),
      }
    }
    const { describeRoutes, describeRouteGraph } = await import("./introspect.ts")
    const mode = value.graph === true ? "graph" : "default"
    const text = value.graph === true ? await describeRouteGraph(app) : await describeRoutes(app)
    const jsonText =
      value.graph === true
        ? await describeRouteGraph(app, { json: true })
        : await describeRoutes(app, { json: true })
    return { ok: true, mode, data: JSON.parse(jsonText) as unknown, text }
  },
  render: (out) => [out.text],
  success: (out) => out.ok,
  json: (out) => out.data,
}

const contextSpec: CommandSpec<ContextInput, ContextCommandOutput> = {
  name: "context",
  summary: "Print the project route index and framework conventions for an agent.",
  input: CONTEXT_SCHEMA,
  output: output({
    type: "object",
    properties: { ok: { type: "boolean" }, text: { type: "string" } },
    required: ["ok", "text"],
  }),
  transports: ["cli", "mcp"],
  stability: "stable",
  argv: {
    flags: [
      { name: "path", field: "path", type: "string" },
      { name: "kind", field: "kind", type: "string" },
    ],
  },
  async run(value, ctx) {
    return {
      ok: true,
      text: (await import("./introspect.ts")).describeProject(await loadAppFor(ctx), {
        ...(value.path === undefined ? {} : { path: value.path }),
        ...(value.kind === undefined ? {} : { kind: value.kind }),
      }),
    }
  },
  render: (out) => [out.text],
}

const openApiSpec: CommandSpec<OpenApiInput, OpenApiCommandOutput> = {
  name: "openapi",
  summary:
    "Generate the backend OpenAPI document, including supported build-time response inference.",
  input: OPENAPI_SCHEMA,
  output: output({
    type: "object",
    properties: { ok: { type: "boolean" }, format: { type: "string" }, text: { type: "string" } },
    required: ["ok", "format", "text"],
  }),
  transports: ["cli"],
  stability: "stable",
  argv: {
    flags: [
      { name: "format", field: "format", type: "string" },
      { name: "path", field: "path", type: "string" },
    ],
  },
  async run(value, ctx) {
    const app = await loadAppFor(ctx)
    const { renderOpenApiWithTypes } = await import("./openapi-tool.ts")
    const format = value.format ?? "json"
    return {
      ok: true,
      format,
      text: await renderOpenApiWithTypes(app, format, value.path),
    }
  },
  render: (out) => [out.text],
  json: (out) => (out.format === "json" ? JSON.parse(out.text) : out.text),
}

const doctorSpec: CommandSpec<DoctorInput, DoctorResult> = {
  name: "doctor",
  summary: "Find undeclared imports, duplicate identity installs, and pipeline readiness drift.",
  input: DOCTOR_SCHEMA,
  output: output({
    type: "object",
    properties: { ok: { type: "boolean" }, findings: { type: "array" } },
    required: ["ok"],
  }),
  transports: ["cli", "mcp"],
  stability: "stable",
  argv: {
    flags: [
      { name: "json", field: "json", type: "boolean" },
      { name: "auto-fix", field: "autoFix", type: "boolean" },
      { name: "fix", field: "autoFix", type: "boolean" },
      { name: "strict", field: "strict", type: "boolean" },
      { name: "target", field: "target", type: "string" },
    ],
  },
  async run(value, ctx) {
    const mod = await import("./doctor.ts")
    const options = {
      ...(value.target === undefined ? {} : { target: value.target }),
      ...(value.strict === undefined ? {} : { strict: value.strict }),
      ...(ctx.cliVersion === undefined ? {} : { cliVersion: ctx.cliVersion }),
    }
    return value.autoFix === true
      ? mod.applyDoctorAutoFix(ctx.cwd, options)
      : mod.collectDoctorResult(ctx.cwd, options)
  },
  render: (out) => [
    out.ok ? "✓ doctor passed" : "✖ doctor found issues",
    ...out.findings.map((f) => `  ${f.file}:${f.line} ${f.package}`),
  ],
  success: (out) => out.ok,
}

const fixSpec: CommandSpec<FixInput, FixCommandOutput> = {
  name: "fix",
  summary: "Apply registered mechanical diagnostic recipes and return remaining findings.",
  input: FIX_SCHEMA,
  output: output({
    type: "object",
    properties: {
      ok: { type: "boolean" },
      changed: { type: "array" },
      failed: { type: "array" },
      diagnostics: { type: "array" },
    },
    required: ["ok", "diagnostics"],
  }),
  transports: ["cli", "mcp"],
  stability: "stable",
  argv: {
    flags: [
      { name: "code", field: "code", type: "string" },
      { name: "json", field: "json", type: "boolean" },
    ],
  },
  async run(value, ctx) {
    const { collectCheckResult } = await import("./check.ts")
    const { applyDiagnosticRecipe } = await import("./fix-recipes.ts")
    const result = await collectCheckResult(ctx.cwd, {
      lintsOnly: true,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    })
    const changed: string[] = []
    const failed: { code: string; reason: string }[] = []
    for (const diagnostic of result.structuredDiagnostics ?? [])
      if (value.code === undefined || diagnostic.code === value.code)
        // One recipe that cannot act must not cancel the others, and must not pass silently either:
        // record why and keep going, so a run over many diagnostics still reports every outcome.
        try {
          changed.push(...(await applyDiagnosticRecipe(ctx.cwd, diagnostic)))
        } catch (error) {
          failed.push({
            code: diagnostic.code,
            reason: error instanceof Error ? error.message : String(error),
          })
        }
    const final = await collectCheckResult(ctx.cwd, {
      lintsOnly: true,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    })
    return {
      ok: final.ok,
      changed,
      failed,
      diagnostics: final.structuredDiagnostics ?? final.diagnostics,
    }
  },
  render: (out) => [
    out.ok ? "✓ fixes applied" : "✖ unresolved diagnostics remain",
    ...out.changed.map((file) => `  changed ${file}`),
    ...out.failed.map((f) => `  could not fix ${f.code}: ${f.reason}`),
    ...out.diagnostics.map((d) => `  ${String((d as { code?: unknown }).code ?? "diagnostic")}`),
  ],
  success: (out) => out.ok,
}

const migrateSpec: CommandSpec<MigrateInput, MigrateCommandOutput> = {
  name: "migrate",
  summary: "Migrate safe static Tailwind className utilities to native StyleX props.",
  input: MIGRATE_SCHEMA,
  output: output({
    type: "object",
    properties: {
      ok: { type: "boolean" },
      from: { type: "string" },
      to: { type: "string" },
      write: { type: "boolean" },
      scanned: { type: "integer" },
      changed: { type: "array" },
      written: { type: "array" },
      issues: { type: "array" },
      files: { type: "array" },
    },
    required: ["ok", "from", "to", "write", "scanned", "changed", "written", "issues", "files"],
  }),
  transports: ["cli"],
  stability: "stable",
  argv: {
    flags: [
      { name: "from", field: "from", type: "string" },
      { name: "to", field: "to", type: "string" },
      { name: "write", field: "write", type: "boolean" },
      { name: "json", field: "json", type: "boolean" },
      { name: "dir", field: "dir", type: "string" },
    ],
  },
  async run(value, ctx) {
    const { migrateTailwindToStylex } = await import("./stylex-migrate.ts")
    return migrateTailwindToStylex(resolve(ctx.cwd, value.dir ?? "."), {
      ...(value.write === undefined ? {} : { write: value.write }),
    })
  },
  render: (out) => [
    out.ok
      ? `✓ migrated ${out.changed.length} file${out.changed.length === 1 ? "" : "s"}`
      : `⚠ migrated ${out.changed.length} safe file${out.changed.length === 1 ? "" : "s"}; ${out.issues.length} manual issue${out.issues.length === 1 ? "" : "s"} remain`,
    `  scanned ${out.scanned} source file${out.scanned === 1 ? "" : "s"}`,
    ...(out.write
      ? [`  wrote ${out.written.length} file${out.written.length === 1 ? "" : "s"}`]
      : out.changed.length > 0
        ? ["  dry run: pass --write to apply the safe changes"]
        : []),
    ...out.issues
      .slice(0, 30)
      .map((issue) => `  ${issue.file}:${issue.line} ${issue.token} — ${issue.reason}`),
    ...(out.issues.length > 30
      ? [`  … ${out.issues.length - 30} more issue${out.issues.length - 30 === 1 ? "" : "s"}`]
      : []),
  ],
  success: (out) => out.ok,
}

const snapshotSpec: CommandSpec<SnapshotInput, SnapshotCommandOutput> = {
  name: "snapshot",
  summary: "Write the backend API contract as a versioned JSON baseline.",
  input: SNAPSHOT_SCHEMA,
  output: output({
    type: "object",
    properties: {
      ok: { type: "boolean" },
      file: { type: "string" },
      routes: { type: "integer" },
      snapshot: { type: "object" },
    },
    required: ["ok", "file", "routes"],
  }),
  transports: ["cli", "mcp"],
  stability: "stable",
  argv: {
    flags: [
      { name: "out", field: "out", type: "string" },
      { name: "json", field: "json", type: "boolean" },
    ],
  },
  async run(value, ctx) {
    const mod = await import("./diff-tool.ts")
    const routes = await mod.snapshotBackend(ctx.cwd)
    const file = value.out ?? mod.DEFAULT_SNAPSHOT_FILE
    const snapshot = { nifraSnapshot: 1 as const, routes }
    await Bun.write(resolve(ctx.cwd, file), `${JSON.stringify(snapshot, null, 2)}\n`)
    return { ok: true, file, routes: routes.length, snapshot }
  },
  render: (out) => [
    `[nifra] wrote ${out.routes} route${out.routes === 1 ? "" : "s"} to ${out.file}`,
  ],
}

const diffSpec: CommandSpec<DiffInput, DiffCommandOutput> = {
  name: "diff",
  summary: "Compare the current backend contract with a baseline and fail on breaking changes.",
  input: DIFF_SCHEMA,
  output: output({
    type: "object",
    properties: {
      ok: { type: "boolean" },
      hasBreaking: { type: "boolean" },
      changes: { type: "array" },
    },
    required: ["ok", "hasBreaking", "changes"],
  }),
  transports: ["cli", "mcp"],
  stability: "stable",
  argv: { positionals: ["baseline"], flags: [{ name: "json", field: "json", type: "boolean" }] },
  async run(value, ctx) {
    const mod = await import("./diff-tool.ts")
    const baseline = value.baseline ?? mod.DEFAULT_SNAPSHOT_FILE
    const file = await Bun.file(resolve(ctx.cwd, baseline)).text()
    const before = mod.parseSnapshotFile(file, baseline)
    const current = await mod.snapshotBackend(ctx.cwd)
    const { diffRouteSnapshots } = await import("@nifrajs/core/diff")
    const diff = diffRouteSnapshots(before.routes, current)
    return { ok: !diff.hasBreaking, hasBreaking: diff.hasBreaking, changes: diff.changes }
  },
  render: (out) => [
    out.ok ? "✓ no breaking changes" : "✖ breaking changes",
    ...(out.changes as readonly { method: string; path: string; message: string }[]).map(
      (c) => `${c.method} ${c.path}: ${c.message}`,
    ),
  ],
  success: (out) => out.ok,
}

const contractsSpec: CommandSpec<ContractsInput, ContractsCommandOutput> = {
  name: "contracts",
  summary: "Snapshot or check the deterministic route contract lock.",
  input: CONTRACTS_SCHEMA,
  output: output({ type: "object" }),
  transports: ["cli", "mcp"],
  stability: "stable",
  argv: {
    positionals: ["action"],
    flags: [
      { name: "out", field: "out", type: "string" },
      { name: "json", field: "json", type: "boolean" },
    ],
  },
  async run(value, ctx) {
    const mod = await import("./contracts.ts")
    if (value.action === "snapshot")
      return { ok: true, lock: await mod.snapshotContracts(ctx.cwd, value.out) }
    const result = await mod.checkContractsLock(ctx.cwd)
    return { ok: result.present && result.diagnostics.length === 0, ...result }
  },
  render: (out) => [
    out.ok ? "✓ contracts are current" : "✖ contract drift",
    ...(out.diagnostics ?? []).map((d) => `  ${(d as { message: string }).message}`),
  ],
  success: (out) => out.ok,
}

const syncManifestSpec: CommandSpec<SyncInput, SyncCommandOutput> = {
  name: "sync-manifest",
  summary: "Regenerate generated server-manifest route tables without a full build.",
  input: SYNC_SCHEMA,
  output: output({
    type: "object",
    properties: { ok: { type: "boolean" }, results: { type: "array" } },
    required: ["ok", "results"],
  }),
  transports: ["cli", "mcp"],
  stability: "stable",
  argv: { flags: [{ name: "json", field: "json", type: "boolean" }] },
  async run(_value, ctx) {
    return {
      ok: true,
      results: await (await import("./sync-manifest.ts")).syncServerManifests(ctx.cwd),
    }
  },
  render: (out) => [
    out.results.length === 0
      ? "nifra sync-manifest: no generated server-manifest.ts found under this directory."
      : `✓ checked ${out.results.length} generated server manifest${out.results.length === 1 ? "" : "s"}`,
  ],
}

const syncRoutesSpec: CommandSpec<SyncInput, SyncCommandOutput> = {
  name: "sync-routes",
  summary: "Regenerate nifra-routes.d.ts so typed navigation follows route search schemas.",
  input: SYNC_SCHEMA,
  output: output({
    type: "object",
    properties: { ok: { type: "boolean" }, results: { type: "array" } },
    required: ["ok", "results"],
  }),
  transports: ["cli", "mcp"],
  stability: "stable",
  argv: { flags: [{ name: "json", field: "json", type: "boolean" }] },
  async run(_value, ctx) {
    const result = await (await import("./sync-routes.ts")).syncRouteTypes(ctx.cwd)
    return { ok: true, results: result === null ? [] : [result] }
  },
  render: (out) => [
    out.results.length === 0
      ? "nifra sync-routes: no routes/ directory found. Run from your project root."
      : `✓ checked ${out.results.length} route type output`,
  ],
}

const proveSpec: CommandSpec<ProveInput, ProjectWorkGraphResult> = {
  name: "prove",
  summary:
    "Build the static verification work graph, plan the cheapest proofs for the changed files, and report a machine-checkable stop condition.",
  input: PROVE_SCHEMA,
  output: output({ type: "object" }),
  transports: ["cli", "mcp"],
  stability: "stable",
  argv: {
    flags: [
      { name: "file", field: "files", type: "string[]" },
      { name: "min", field: "minLevel", type: "number" },
      { name: "json", field: "json", type: "boolean" },
    ],
  },
  async run(value, ctx) {
    return collectProjectWorkGraph(ctx.cwd, {
      ...(value.files === undefined ? {} : { changedFiles: value.files }),
      ...(value.minLevel === undefined ? {} : { minLevel: value.minLevel }),
    })
  },
  render: (out) => [renderWorkGraphText(out)],
  success: (out) => out.evidence.stop.done,
}

const replaySpec: CommandSpec<ReplayInput, ReplayResult> = {
  name: "replay",
  summary: "Validate a token-only verification metadata file and dispatch it against its gate.",
  input: REPLAY_SCHEMA,
  output: output({ type: "object" }),
  transports: ["cli", "mcp"],
  stability: "stable",
  argv: { positionals: ["file"] },
  async run(value, ctx) {
    const { runReplay } = await import("./replay.ts")
    return runReplay(ctx.cwd, value.file)
  },
  render: (out) => [JSON.stringify(out, null, 2)],
  success: (out) => out.ok,
}

const portSpec: CommandSpec<PortInput, PortResult> = {
  name: "port",
  summary:
    "Print a feature by deploy-target portability matrix with file:line evidence and gate against an unsupported target.",
  input: PORT_SCHEMA,
  output: output({ type: "object" }),
  transports: ["cli", "mcp"],
  stability: "stable",
  argv: {
    flags: [
      { name: "target", field: "target", type: "string" },
      { name: "json", field: "json", type: "boolean" },
      { name: "ci", field: "ci", type: "boolean" },
      { name: "strict", field: "strict", type: "boolean" },
    ],
  },
  async run(value, ctx) {
    return collectPortResult(ctx.cwd, {
      ...(value.target === undefined ? {} : { target: value.target }),
      ...(value.strict === true ? { strict: true } : {}),
    })
  },
  render: (out, input) => {
    const report = renderReport(out, { strict: input?.strict === true })
    const gating = input?.ci === true || input?.target !== undefined
    if (gating && out.resolved === undefined)
      return [
        report,
        "",
        "[nifra] --ci needs a deploy target to gate against, and none was detected. Pass --target <bun|node|deno|cf-pages|vercel>.",
      ]
    return [report]
  },
  success: (out, input) => {
    const gating = input.ci === true || input.target !== undefined
    if (!gating) return true
    if (out.resolved === undefined) return false
    return out.json.blocked.length === 0
  },
  json: (out) => out.json,
}

export const commandSpecs = Object.freeze([
  checkSpec,
  assureSpec,
  levelsSpec,
  capabilitiesSpec,
  manifestSpec,
  routesSpec,
  contextSpec,
  openApiSpec,
  doctorSpec,
  fixSpec,
  migrateSpec,
  snapshotSpec,
  diffSpec,
  contractsSpec,
  syncManifestSpec,
  syncRoutesSpec,
  proveSpec,
  replaySpec,
  portSpec,
] as const)

const commandByName = new Map(commandSpecs.map((spec) => [spec.name, spec]))

export function findCommandSpec(name: string): CommandSpec<unknown, unknown> | undefined {
  return commandByName.get(name) as CommandSpec<unknown, unknown> | undefined
}

export const commandCatalog = Object.freeze(
  commandSpecs.map((spec) => toCommandCatalogEntry(spec as CommandSpec<unknown, unknown>)),
)

export function commandMcpName(name: string): string {
  return `nifra_${name.replaceAll("-", "_")}`
}

export function commandUsage<Input, Output>(spec: CommandSpec<Input, Output>): string {
  const positionals = (spec.argv?.positionals ?? []).map((field) => `<${field}>`).join(" ")
  const flags = (spec.argv?.flags ?? [])
    .filter((flag, index, all) => all.findIndex((x) => x.field === flag.field) === index)
    .map((flag) => (flag.type === "boolean" ? `[--${flag.name}]` : `[--${flag.name} <value>]`))
    .join(" ")
  return [positionals, flags].filter(Boolean).join(" ")
}

/** Stable one-line help/card projection; command-specific prose lives only in the catalog. */
export function renderCommandCatalogLines(prefix = "nifra"): readonly string[] {
  return commandCatalog.map((entry) => {
    const spec = findCommandSpec(entry.name) as CommandSpec<unknown, unknown>
    const usage = commandUsage(spec)
    return `${prefix} ${entry.name}${usage === "" ? "" : ` ${usage}`} - ${entry.summary}`
  })
}

export function renderCommandCatalogHelp(): string {
  return ["", "Stable project command catalog:", ...renderCommandCatalogLines("  nifra")].join("\n")
}

export function parseCommandOutput<Input, Output>(
  spec: CommandSpec<Input, Output>,
  value: unknown,
): Output {
  const raw = record(value)
  if (raw.nifraCommand !== undefined && raw.version !== undefined && raw.result !== undefined) {
    if (raw.version !== spec.output.version)
      throw new Error(`unsupported ${spec.name} output version: ${String(raw.version)}`)
    return spec.output.parse(raw.result)
  }
  return spec.output.parse(value)
}

/** Serialize a result as an envelope without forcing existing raw --json consumers to migrate. */
export function envelopeCommandOutput<Input, Output>(
  spec: CommandSpec<Input, Output>,
  value: Output,
): { readonly nifraCommand: string; readonly version: number; readonly result: Output } {
  return { nifraCommand: spec.name, version: spec.output.version, result: value }
}
