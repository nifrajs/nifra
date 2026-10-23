/**
 * Run tool contracts from a command line - the CLI adapter beside {@link createToolHttpHandler} and
 * `@nifrajs/mcp`'s `toMcpTool`. Every call goes through {@link executeTool}, so admission, approval,
 * dry-run, validation and evidence are the contract's, not this module's.
 *
 * ```ts
 * import { runToolCli } from "@nifrajs/core/tool-cli"
 *
 * process.exitCode = await runToolCli([search, publish], process.argv.slice(2), {
 *   program: "acme",
 *   capabilities: [search.capability, publish.capability],
 * })
 * ```
 *
 * Grammar: `<program> <tool> [--<property> <value>]... [--input <json> | --input -] [--dry-run]
 * [--yes] [--approve-level <n>] [--json]`. A flag names one top-level property of the tool's input
 * schema, spelled exactly as declared. String, number, integer and boolean properties take a plain
 * value (`--no-<property>` sets a boolean false); an array of those repeats the flag once per item;
 * anything else takes JSON. `--input` supplies the whole input as JSON (`-` reads stdin) and flags
 * override its fields. Approval comes only from the command line: `--yes`, or `--approve-level <n>`
 * for a threshold policy.
 *
 * The result goes to stdout as the output's JSON; `--json` prints the full result envelope (the HTTP
 * adapter's body shape) instead. Exit codes are {@link TOOL_CLI_EXIT}: usage errors and invalid input
 * are `2`, a refusal (capability, policy, approval) is `3`, any other failure is `1`.
 */

import { type ProtoPoisoning, parseJsonGuarded } from "./server/proto-guard.ts"
import {
  DEFAULT_TOOL_MAX_BYTES,
  executeTool,
  type ToolApproval,
  type ToolCallOptions,
  type ToolCallResult,
  type ToolContract,
  type ToolError,
  toolInputJsonSchema,
} from "./tool-contract.ts"

/** Process exit codes {@link runToolCli} resolves to. */
export const TOOL_CLI_EXIT: Readonly<{ ok: 0; failed: 1; usage: 2; refused: 3 }> = Object.freeze({
  ok: 0,
  failed: 1,
  usage: 2,
  refused: 3,
})

/** Where the CLI writes. `process.stdout` / `process.stderr` / `process.stdin` satisfy it. */
export interface ToolCliStreams {
  readonly stdout: { write(chunk: string): unknown }
  readonly stderr: { write(chunk: string): unknown }
  /** Read by `--input -`. */
  readonly stdin?: AsyncIterable<Uint8Array | string>
}

export interface ToolCliOptions extends Omit<ToolCallOptions, "approval" | "dryRun" | "ledger"> {
  /** The command name shown in usage text. */
  readonly program: string
  /** Default: the process streams. */
  readonly streams?: ToolCliStreams
  /** Cap on `--input` JSON, inline or from stdin, in UTF-8 bytes. Default 1 MiB. */
  readonly maxInputBytes?: number
  /** Prototype-poisoning policy for every JSON value read. Default `"reject"`. */
  readonly protoPoisoning?: ProtoPoisoning
}

/** A heterogeneous tool list. Each contract still validates its own input at execution. */
// biome-ignore lint/suspicious/noExplicitAny: a heterogeneous tool list is erased at this boundary; each contract validates at execution.
export type CliToolContract = ToolContract<any, any>

const RESERVED = new Set(["help", "input", "dry-run", "yes", "approve-level", "json"])
const INTEGER = /^-?(?:0|[1-9]\d*)$/
const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/

type Primitive = "string" | "number" | "integer" | "boolean"

interface Flag {
  readonly name: string
  readonly kind: Primitive | "json"
  readonly repeated: boolean
  readonly required: boolean
  readonly description: string | undefined
}

interface Invocation {
  readonly input: unknown
  readonly dryRun: boolean
  readonly approval: ToolApproval | undefined
  readonly json: boolean
}

type Parsed =
  | { readonly kind: "help" }
  | { readonly kind: "run"; readonly invocation: Invocation }
  | { readonly kind: "usage"; readonly message: string }

/**
 * Run one command line against `tools`. Resolves to the exit code; it never throws for anything a
 * user typed. `argv` excludes the runtime and script (`process.argv.slice(2)`).
 */
export async function runToolCli(
  tools: readonly CliToolContract[],
  argv: readonly string[],
  options: ToolCliOptions,
): Promise<number> {
  const { program, streams, maxInputBytes, protoPoisoning, ...callOptions } = options
  const names = new Set<string>()
  for (const tool of tools) {
    if (names.has(tool.name)) throw new TypeError(`runToolCli: duplicate tool ${tool.name}`)
    names.add(tool.name)
  }
  const cap = maxInputBytes ?? DEFAULT_TOOL_MAX_BYTES
  if (!Number.isSafeInteger(cap) || cap <= 0) {
    throw new RangeError("runToolCli: maxInputBytes must be a positive safe integer")
  }
  const io = streams ?? processStreams()
  const policy = protoPoisoning ?? "reject"

  const [first, ...rest] = argv
  if (first === undefined) {
    io.stderr.write(programUsage(program, tools))
    return TOOL_CLI_EXIT.usage
  }
  if (first === "--help" || first === "-h") {
    io.stdout.write(programUsage(program, tools))
    return TOOL_CLI_EXIT.ok
  }
  const tool = tools.find((candidate) => candidate.name === first)
  if (tool === undefined) {
    io.stderr.write(
      `${program}: unknown tool ${JSON.stringify(first)}\n\n${programUsage(program, tools)}`,
    )
    return TOOL_CLI_EXIT.usage
  }

  const flags = flagsOf(tool)
  const parsed = await parseInvocation(rest, flags, { io, cap, policy })
  if (parsed.kind === "help") {
    io.stdout.write(toolUsage(program, tool, flags))
    return TOOL_CLI_EXIT.ok
  }
  if (parsed.kind === "usage") {
    io.stderr.write(
      `${program} ${tool.name}: ${parsed.message}\nRun \`${program} ${tool.name} --help\` for its options.\n`,
    )
    return TOOL_CLI_EXIT.usage
  }

  const { invocation } = parsed
  const call: { -readonly [Key in keyof ToolCallOptions]: ToolCallOptions[Key] } = {
    ...callOptions,
    dryRun: invocation.dryRun,
  }
  if (invocation.approval !== undefined) call.approval = invocation.approval
  const result = await executeTool(tool, invocation.input, call)
  return report(result, { program, tool, json: invocation.json, io })
}

function report(
  result: ToolCallResult<unknown>,
  context: {
    readonly program: string
    readonly tool: CliToolContract
    readonly json: boolean
    readonly io: ToolCliStreams
  },
): number {
  const { io, program, tool } = context
  const code = result.ok ? TOOL_CLI_EXIT.ok : exitCodeOf(result.error.code)
  let text: string | undefined
  try {
    if (context.json) {
      text = JSON.stringify(
        result.ok
          ? { ok: true, output: result.output, dryRun: result.dryRun, evidence: result.evidence }
          : { ok: false, error: result.error, dryRun: result.dryRun, evidence: result.evidence },
      )
    } else if (result.ok && result.output !== undefined) {
      text = JSON.stringify(result.output, null, 2)
    }
  } catch {
    io.stderr.write(`${program} ${tool.name}: the result is not JSON-serializable\n`)
    return TOOL_CLI_EXIT.failed
  }
  if (text !== undefined) io.stdout.write(`${text}\n`)
  if (context.json) return code
  if (result.ok) {
    if (result.dryRun)
      io.stderr.write(`${program} ${tool.name}: dry run admitted; nothing executed\n`)
    return code
  }
  io.stderr.write(failureText(program, tool, result.error))
  return code
}

function failureText(program: string, tool: CliToolContract, error: ToolError): string {
  const lines = [`${program} ${tool.name}: ${error.code} (${error.stage})`]
  for (const issue of error.issues ?? []) lines.push(`  ${issuePath(issue.path)}: ${issue.message}`)
  if (error.code === "approval_required" || error.code === "approval_denied") {
    lines.push(
      tool.approval.kind === "threshold"
        ? `  approve with --approve-level ${tool.approval.level}`
        : "  approve with --yes",
    )
  }
  return `${lines.join("\n")}\n`
}

function issuePath(path: readonly unknown[] | undefined): string {
  if (path === undefined || path.length === 0) return "input"
  const keys = path.map((segment) =>
    segment !== null && typeof segment === "object" && "key" in segment ? segment.key : segment,
  )
  return keys.map((key) => (typeof key === "symbol" ? key.toString() : String(key))).join(".")
}

function exitCodeOf(code: ToolError["code"]): number {
  switch (code) {
    case "input_invalid":
      return TOOL_CLI_EXIT.usage
    case "capability_denied":
    case "execution_policy_unsatisfied":
    case "approval_required":
    case "approval_denied":
      return TOOL_CLI_EXIT.refused
    default:
      return TOOL_CLI_EXIT.failed
  }
}

async function parseInvocation(
  args: readonly string[],
  flags: ReadonlyMap<string, Flag>,
  context: { readonly io: ToolCliStreams; readonly cap: number; readonly policy: ProtoPoisoning },
): Promise<Parsed> {
  const fields = new Map<string, unknown>()
  let inputText: string | undefined
  let inputFromStdin = false
  let dryRun = false
  let yes = false
  let level: number | undefined
  let json = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? ""
    if (arg === "--help" || arg === "-h") return { kind: "help" }
    if (!arg.startsWith("--") || arg === "--") {
      return { kind: "usage", message: `unexpected argument ${JSON.stringify(arg)}` }
    }
    const equals = arg.indexOf("=")
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals)
    const inline = equals === -1 ? undefined : arg.slice(equals + 1)
    const takeValue = (): string | undefined => {
      if (inline !== undefined) return inline
      const next = args[index + 1]
      if (next === undefined || next.startsWith("--")) return undefined
      index += 1
      return next
    }

    if (RESERVED.has(name)) {
      if (name === "dry-run" || name === "yes" || name === "json") {
        if (inline !== undefined) return { kind: "usage", message: `--${name} takes no value` }
        if (name === "dry-run") dryRun = true
        else if (name === "yes") yes = true
        else json = true
        continue
      }
      const value = takeValue()
      if (value === undefined) return { kind: "usage", message: `--${name} needs a value` }
      if (name === "approve-level") {
        if (!INTEGER.test(value) || Number(value) <= 0) {
          return { kind: "usage", message: "--approve-level needs a positive integer" }
        }
        level = Number(value)
        continue
      }
      if (inputText !== undefined || inputFromStdin) {
        return { kind: "usage", message: "--input given twice" }
      }
      if (value === "-") inputFromStdin = true
      else inputText = value
      continue
    }

    const negated = name.startsWith("no-") ? flags.get(name.slice(3)) : undefined
    if (
      negated !== undefined &&
      negated.kind === "boolean" &&
      inline === undefined &&
      !flags.has(name)
    ) {
      if (fields.has(negated.name))
        return { kind: "usage", message: `--${negated.name} given twice` }
      fields.set(negated.name, false)
      continue
    }
    const flag = flags.get(name)
    if (flag === undefined) return { kind: "usage", message: `unknown option --${name}` }
    if (!flag.repeated && fields.has(flag.name)) {
      return { kind: "usage", message: `--${flag.name} given twice` }
    }
    let raw: string | undefined
    if (flag.kind === "boolean" && !flag.repeated && inline === undefined) raw = "true"
    else raw = takeValue()
    if (raw === undefined) return { kind: "usage", message: `--${flag.name} needs a value` }
    const value = coerce(raw, flag.kind, context.policy)
    if (!value.ok) return { kind: "usage", message: `--${flag.name}: ${value.message}` }
    if (flag.repeated) {
      const items = fields.get(flag.name)
      if (Array.isArray(items)) items.push(value.value)
      else fields.set(flag.name, [value.value])
    } else {
      fields.set(flag.name, value.value)
    }
  }

  let input: unknown
  if (inputText !== undefined || inputFromStdin) {
    const text = inputFromStdin ? await readStdin(context.io, context.cap) : inputText
    if (text === undefined) return { kind: "usage", message: "--input - needs a readable stdin" }
    if (typeof text === "object") return { kind: "usage", message: text.message }
    if (new TextEncoder().encode(text).byteLength > context.cap) {
      return { kind: "usage", message: `--input exceeds ${context.cap} bytes` }
    }
    const parsed = parseJson(text, context.policy)
    if (!parsed.ok) return { kind: "usage", message: `--input: ${parsed.message}` }
    input = parsed.value
  }
  if (fields.size > 0) {
    if (
      input !== undefined &&
      (input === null || typeof input !== "object" || Array.isArray(input))
    ) {
      return { kind: "usage", message: "options need --input to be a JSON object" }
    }
    const merged: Record<string, unknown> = {}
    if (input !== undefined)
      for (const [key, value] of Object.entries(input)) define(merged, key, value)
    for (const [key, value] of fields) define(merged, key, value)
    input = merged
  }

  let approval: ToolApproval | undefined
  if (level !== undefined) approval = { granted: true, level }
  else if (yes) approval = { granted: true }
  return { kind: "run", invocation: { input: input ?? {}, dryRun, approval, json } }
}

// `__proto__` as a declared property name must become an own field, never the prototype.
function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

function coerce(
  raw: string,
  kind: Flag["kind"],
  policy: ProtoPoisoning,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string } {
  switch (kind) {
    case "string":
      return { ok: true, value: raw }
    case "boolean":
      if (raw === "true") return { ok: true, value: true }
      if (raw === "false") return { ok: true, value: false }
      return { ok: false, message: "expected true or false" }
    case "integer": {
      if (!INTEGER.test(raw)) return { ok: false, message: "expected an integer" }
      const value = Number(raw)
      return Number.isSafeInteger(value)
        ? { ok: true, value }
        : { ok: false, message: "integer is out of the safe range" }
    }
    case "number": {
      if (!DECIMAL.test(raw)) return { ok: false, message: "expected a number" }
      const value = Number(raw)
      return Number.isFinite(value)
        ? { ok: true, value }
        : { ok: false, message: "number is not finite" }
    }
    default:
      return parseJson(raw, policy)
  }
}

function parseJson(
  text: string,
  policy: ProtoPoisoning,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string } {
  try {
    return {
      ok: true,
      value: policy === "ignore" ? JSON.parse(text) : parseJsonGuarded(text, policy),
    }
  } catch {
    return { ok: false, message: "expected JSON" }
  }
}

async function readStdin(
  io: ToolCliStreams,
  cap: number,
): Promise<string | { readonly message: string } | undefined> {
  if (io.stdin === undefined) return undefined
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  let total = 0
  for await (const chunk of io.stdin) {
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk
    total += bytes.byteLength
    if (total > cap) return { message: `--input exceeds ${cap} bytes` }
    parts.push(bytes.slice())
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.byteLength
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(joined)
  } catch {
    return { message: "--input: stdin is not UTF-8" }
  }
}

function flagsOf(tool: CliToolContract): ReadonlyMap<string, Flag> {
  const schema = toolInputJsonSchema(tool)
  const properties = record(schema.properties)
  const required = Array.isArray(schema.required) ? schema.required : []
  const flags = new Map<string, Flag>()
  if (properties === undefined) return flags
  for (const [name, value] of Object.entries(properties)) {
    if (RESERVED.has(name)) continue
    const property = record(value) ?? {}
    const items = property.type === "array" ? record(property.items) : undefined
    const itemKind = items === undefined ? undefined : primitiveOf(items)
    const description = typeof property.description === "string" ? property.description : undefined
    flags.set(name, {
      name,
      kind: items === undefined ? (primitiveOf(property) ?? "json") : (itemKind ?? "json"),
      repeated: items !== undefined,
      required: required.includes(name),
      description,
    })
  }
  return flags
}

function primitiveOf(schema: Record<string, unknown>): Primitive | undefined {
  const type = schema.type
  if (typeof type === "string") return isPrimitive(type) ? type : undefined
  if (Array.isArray(type)) {
    const kinds = type.filter((entry) => entry !== "null")
    const [only] = kinds
    return kinds.length === 1 && typeof only === "string" && isPrimitive(only) ? only : undefined
  }
  const literals = Array.isArray(schema.enum)
    ? schema.enum
    : "const" in schema
      ? [schema.const]
      : undefined
  if (literals !== undefined && literals.length > 0) {
    if (literals.every((literal) => typeof literal === "string")) return "string"
    if (literals.every((literal) => typeof literal === "number")) return "number"
    return undefined
  }
  const members = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined
  if (members === undefined || members.length === 0) return undefined
  const kinds = new Set(members.map((member) => primitiveOf(record(member) ?? {})))
  const [only] = kinds
  return kinds.size === 1 ? only : undefined
}

function isPrimitive(type: string): type is Primitive {
  return type === "string" || type === "number" || type === "integer" || type === "boolean"
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) out[key] = entry
  return out
}

function programUsage(program: string, tools: readonly CliToolContract[]): string {
  const width = Math.max(0, ...tools.map((tool) => tool.name.length))
  const rows = tools.map((tool) => `  ${tool.name.padEnd(width)}  ${oneLine(tool.description)}`)
  return [
    `Usage: ${program} <tool> [options]`,
    "",
    "Tools:",
    ...rows,
    "",
    `Run \`${program} <tool> --help\` for a tool's options.`,
    "",
  ].join("\n")
}

function toolUsage(
  program: string,
  tool: CliToolContract,
  flags: ReadonlyMap<string, Flag>,
): string {
  const rows: [string, string][] = []
  for (const flag of flags.values()) {
    const value = flag.kind === "boolean" && !flag.repeated ? "" : ` <${flag.kind}>`
    const spelling =
      flag.kind === "boolean" && !flag.repeated
        ? `--${flag.name} / --no-${flag.name}`
        : `--${flag.name}${value}`
    const notes = [
      flag.required ? "required" : undefined,
      flag.repeated ? "repeatable" : undefined,
      flag.description === undefined ? undefined : oneLine(flag.description),
    ].filter((note) => note !== undefined)
    rows.push([spelling, notes.join("; ")])
  }
  rows.push([
    "--input <json>|-",
    "the whole input as JSON, `-` reads stdin; options above override its fields",
  ])
  rows.push(["--dry-run", "admit the call without running it"])
  if (tool.approval.kind === "required")
    rows.push(["--yes", "approve this call (the tool requires approval)"])
  if (tool.approval.kind === "threshold") {
    rows.push(["--approve-level <n>", `approve at level n; this tool needs ${tool.approval.level}`])
  }
  rows.push(["--json", "print the result envelope as JSON"])
  const width = Math.max(...rows.map(([spelling]) => spelling.length))
  return [
    `Usage: ${program} ${tool.name} [options]`,
    "",
    oneLine(tool.description),
    "",
    "Options:",
    ...rows.map(([spelling, note]) => `  ${spelling.padEnd(width)}  ${note}`.trimEnd()),
    "",
  ].join("\n")
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function processStreams(): ToolCliStreams {
  const host: unknown = Reflect.get(globalThis, "process")
  const stream = (name: string): unknown =>
    host !== null && typeof host === "object" ? Reflect.get(host, name) : undefined
  const stdout = stream("stdout")
  const stderr = stream("stderr")
  const stdin = stream("stdin")
  if (!isWritable(stdout) || !isWritable(stderr)) {
    throw new TypeError("runToolCli: this runtime has no process streams; pass `streams`")
  }
  return isReadable(stdin) ? { stdout, stderr, stdin } : { stdout, stderr }
}

function isWritable(value: unknown): value is { write(chunk: string): unknown } {
  return (
    value !== null && typeof value === "object" && typeof Reflect.get(value, "write") === "function"
  )
}

function isReadable(value: unknown): value is AsyncIterable<Uint8Array | string> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof Reflect.get(value, Symbol.asyncIterator) === "function"
  )
}
