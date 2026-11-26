import { createHash } from "node:crypto"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  type WorkflowEvent,
  type WorkflowResult,
  WorkflowRunner,
  type WorkflowStep,
} from "./workflows.ts"

export interface ExtensionContext {
  readonly cwd: string
  readonly registerCommand: (name: string, handler: ExtensionCommand) => void
  readonly registerTool: (tool: ExtensionTool) => void
  readonly registerWorkflow: (name: string, workflow: ExtensionWorkflow) => void
  readonly registerSubagent: (role: ExtensionSubagent) => void
  readonly registerProvider: (provider: ExtensionProvider) => void
  readonly on: (event: string, handler: ExtensionEventHandler) => void
}

export type ExtensionCommand = (
  args: string,
  context: ExtensionContext,
) => unknown | PromiseLike<unknown>

export interface ExtensionTool {
  readonly name: string
  readonly description: string
  readonly capabilities?: readonly string[]
  readonly execute: (input: unknown, context: ExtensionContext) => unknown | PromiseLike<unknown>
}

export interface ExtensionSubagent {
  readonly name: string
  readonly description: string
  readonly prompt: string
  readonly capabilities?: readonly string[]
  readonly maxDepth?: number
}

export interface ExtensionProvider {
  readonly name: string
  readonly description: string
  readonly capabilities?: readonly string[]
}

export type ExtensionEventHandler = (
  payload: unknown,
  context: ExtensionContext,
) => unknown | PromiseLike<unknown>

/** A workflow factory keeps orchestration lazy and lets every extension fully customize its steps. */
export type ExtensionWorkflow = (
  context: ExtensionContext,
) => WorkflowStep | PromiseLike<WorkflowStep>

export interface WorkflowRunOptions {
  readonly signal?: AbortSignal
  readonly maxSteps?: number
  readonly maxDepth?: number
  readonly onEvent?: (event: WorkflowEvent) => void | PromiseLike<void>
  readonly exposeErrorStacks?: boolean
}

export interface CodingAgentExtension {
  readonly id: string
  readonly path: string
  readonly capabilities: readonly string[]
  readonly dispose?: () => void | PromiseLike<void>
}

export interface ExtensionReloadResult {
  readonly revision: string
  readonly loaded: readonly string[]
  readonly disabled: readonly string[]
  readonly rolledBack: boolean
  readonly error?: string
}

export interface ExtensionHostOptions {
  readonly cwd: string
  readonly roots: readonly string[]
  readonly trustedCapabilities?: readonly string[]
  /** Optional fast syntax/type/build gate that runs before a module is staged. */
  readonly validate?: (path: string) => void | PromiseLike<void>
  readonly onError?: (error: { readonly path: string; readonly error: unknown }) => void
}

/** Discover only project-local extension files; no home-directory or dependency scan is implicit. */
export async function discoverExtensions(cwd: string): Promise<readonly string[]> {
  const directory = resolve(cwd, ".nifra/extensions")
  if (!existsSync(directory)) return Object.freeze([])
  const roots: string[] = []
  for await (const path of new Bun.Glob("**/*").scan({ cwd: directory, dot: false })) {
    if (/\.(?:ts|tsx|js|jsx)$/.test(path)) roots.push(join(".nifra/extensions", path))
  }
  return Object.freeze(roots.sort())
}

/** Parse an extension without activating it. This is a fast syntax gate before staging. */
export async function validateExtensionModule(path: string): Promise<void> {
  const source = await Bun.file(path).text()
  const loader = /\.tsx?$/.test(path) ? "tsx" : "js"
  try {
    new Bun.Transpiler({ loader }).transformSync(source)
  } catch (error) {
    throw new Error(
      `extension validation failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

type ExtensionFactory = (
  context: ExtensionContext,
) =>
  | void
  | { readonly dispose?: () => void | PromiseLike<void> }
  | PromiseLike<void | { readonly dispose?: () => void | PromiseLike<void> }>

function createRegistrations() {
  return {
    commands: new Map<string, ExtensionCommand>(),
    tools: new Map<string, ExtensionTool>(),
    workflows: new Map<string, ExtensionWorkflow>(),
    subagents: new Map<string, ExtensionSubagent>(),
    providers: new Map<string, ExtensionProvider>(),
    handlers: new Map<string, ExtensionEventHandler[]>(),
  }
}

type ExtensionRegistrations = ReturnType<typeof createRegistrations>

interface ExtensionActivation {
  readonly extension: CodingAgentExtension
  readonly digest: string
  readonly registrations: ExtensionRegistrations
  /** What this extension's callbacks register through: kept in `registrations`, so a reload replays it. */
  readonly context: ExtensionContext
  /** The host's live registry while this activation is committed: where a late registration also goes. */
  live: ExtensionContext | undefined
}

interface ExtensionSnapshot {
  readonly contents: string
  readonly loader: "ts" | "tsx" | "js" | "jsx"
}

const extensionSnapshots = new Map<string, ExtensionSnapshot>()
let snapshotPluginRegistered = false

function ensureExtensionSnapshotLoader(): void {
  if (snapshotPluginRegistered) return
  snapshotPluginRegistered = true
  Bun.plugin({
    name: "nifra-coding-agent-extension-snapshot",
    setup(build) {
      build.onLoad({ filter: /\?nifraExtensionRevision=/ }, (args) => {
        const snapshot = extensionSnapshots.get(args.path)
        if (snapshot === undefined) {
          throw new Error(`missing verified snapshot for extension ${args.path}`)
        }
        return { contents: snapshot.contents, loader: snapshot.loader }
      })
    },
  })
}

function extensionLoaderFor(path: string): "ts" | "tsx" | "js" | "jsx" {
  if (path.endsWith(".tsx")) return "tsx"
  if (path.endsWith(".jsx")) return "jsx"
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) return "js"
  return "ts"
}

let activationSequence = 0

function replayRegistrations(
  registrations: ExtensionRegistrations,
  target: ExtensionContext,
): void {
  for (const [name, command] of registrations.commands) target.registerCommand(name, command)
  for (const tool of registrations.tools.values()) target.registerTool(tool)
  for (const [name, workflow] of registrations.workflows) target.registerWorkflow(name, workflow)
  for (const role of registrations.subagents.values()) target.registerSubagent(role)
  for (const provider of registrations.providers.values()) target.registerProvider(provider)
  for (const [event, handlers] of registrations.handlers)
    for (const handler of handlers) target.on(event, handler)
}

/**
 * Transactional TypeScript extension loader for the Nifra-native backend.
 *
 * This loader only activates explicitly supplied files. It never scans a project implicitly and it
 * leaves the previous extension graph intact when a staged reload fails.
 */
export class ExtensionHost {
  private readonly options: ExtensionHostOptions
  private active: readonly CodingAgentExtension[] = []
  private activations: readonly ExtensionActivation[] = []
  private registrations = createRegistrations()
  private lifecycle: Promise<unknown> = Promise.resolve()
  private revision = "0"

  constructor(options: ExtensionHostOptions) {
    this.options = Object.freeze({
      ...options,
      roots: Object.freeze([...options.roots]),
      trustedCapabilities: Object.freeze([...(options.trustedCapabilities ?? [])]),
    })
  }

  get extensions(): readonly CodingAgentExtension[] {
    return this.active
  }

  get currentRevision(): string {
    return this.revision
  }

  get availableCommands(): readonly string[] {
    return Object.freeze([...this.registrations.commands.keys()].sort())
  }

  get availableTools(): readonly ExtensionTool[] {
    return Object.freeze([...this.registrations.tools.values()])
  }

  get availableWorkflows(): readonly string[] {
    return Object.freeze([...this.registrations.workflows.keys()].sort())
  }

  get availableSubagents(): readonly ExtensionSubagent[] {
    return Object.freeze([...this.registrations.subagents.values()])
  }

  get availableProviders(): readonly ExtensionProvider[] {
    return Object.freeze([...this.registrations.providers.values()])
  }

  reload(): Promise<ExtensionReloadResult> {
    return this.runLifecycle(() => this.reloadOnce())
  }

  // A staged reload and a close must not dispose activations that another operation is retaining.
  private runLifecycle<T>(run: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(run, run)
    this.lifecycle = next
    return next
  }

  private async reloadOnce(): Promise<ExtensionReloadResult> {
    let pathError: string | undefined
    const paths = this.options.roots
      .map((root) => resolve(this.options.cwd, root))
      .filter((path) => {
        if (!isWithin(this.options.cwd, path)) {
          pathError = `extension path escapes project root: ${path}`
          return false
        }
        if (!existsSync(path)) return false
        try {
          if (!isWithin(this.options.cwd, realpathSync(path))) {
            pathError = `extension path escapes project root: ${path}`
            return false
          }
          return true
        } catch {
          pathError = `extension path could not be resolved: ${path}`
          return false
        }
      })
    const next: ExtensionActivation[] = []
    const created: ExtensionActivation[] = []
    const staging = this.context(createRegistrations())
    const committed = createRegistrations()
    const live = this.context(committed)
    try {
      if (pathError !== undefined) throw new Error(pathError)
      for (const path of paths) {
        await this.options.validate?.(path)
        const canonicalPath = realpathSync(path)
        const rawBytes = readFileSync(canonicalPath)
        const digest = createHash("sha256").update(rawBytes).digest("hex")
        let activation = this.activations.find(
          (candidate) =>
            candidate.extension.path === path &&
            candidate.digest === digest &&
            !next.includes(candidate),
        )
        if (activation === undefined) {
          activation = await this.loadOne(path, canonicalPath, digest, rawBytes)
          created.push(activation)
        }
        replayRegistrations(activation.registrations, staging)
        next.push(activation)
      }
      // Replayed again with no await between: a retained extension may have registered more while
      // a later one was loading.
      for (const activation of next) replayRegistrations(activation.registrations, live)
    } catch (error) {
      for (const { extension } of created.reverse()) {
        try {
          await extension.dispose?.()
        } catch {
          /* staged cleanup is best effort */
        }
      }
      const message = error instanceof Error ? error.message : String(error)
      this.options.onError?.({ path: paths[next.length] ?? this.options.cwd, error })
      return {
        revision: this.revision,
        loaded: Object.freeze(this.active.map((extension) => extension.id)),
        disabled: Object.freeze(paths.slice(next.length)),
        rolledBack: true,
        error: message,
      }
    }

    const previous = this.activations
    for (const activation of previous) activation.live = undefined
    for (const activation of next) activation.live = live
    this.activations = next
    this.active = Object.freeze(next.map(({ extension }) => extension))
    this.registrations = committed
    this.revision = `${Date.now().toString(36)}-${next.length}`
    for (const activation of previous) {
      if (next.includes(activation)) continue
      const { extension } = activation
      try {
        await extension.dispose?.()
      } catch (error) {
        this.options.onError?.({ path: extension.path, error })
      }
    }
    return {
      revision: this.revision,
      loaded: Object.freeze(this.active.map((extension) => extension.id)),
      disabled: [],
      rolledBack: false,
    }
  }

  close(): Promise<void> {
    return this.runLifecycle(async () => {
      const active = this.active
      for (const activation of this.activations) activation.live = undefined
      this.active = []
      this.activations = []
      this.registrations = createRegistrations()
      const failures: unknown[] = []
      for (const extension of active) {
        try {
          await extension.dispose?.()
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length > 0) throw failures[0]
    })
  }

  command(name: string): ExtensionCommand | undefined {
    return this.registrations.commands.get(name)
  }

  tool(name: string): ExtensionTool | undefined {
    return this.registrations.tools.get(name)
  }

  workflow(name: string): ExtensionWorkflow | undefined {
    return this.registrations.workflows.get(name)
  }

  subagent(name: string): ExtensionSubagent | undefined {
    return this.registrations.subagents.get(name)
  }

  provider(name: string): ExtensionProvider | undefined {
    return this.registrations.providers.get(name)
  }

  async runWorkflow(name: string, options: WorkflowRunOptions = {}): Promise<WorkflowResult> {
    const owner = this.activations.find(({ registrations }) => registrations.workflows.has(name))
    const workflow = owner?.registrations.workflows.get(name)
    if (owner === undefined || workflow === undefined)
      throw new Error(`unknown extension workflow: ${name}`)
    const step = await workflow(owner.context)
    return new WorkflowRunner(options).run(step)
  }

  async emit(event: string, payload: unknown): Promise<void> {
    // Collected first: a handler that registers another does not run it in this emit.
    const calls = this.activations.flatMap(({ registrations, context }) =>
      (registrations.handlers.get(event) ?? []).map((handler) => ({ handler, context })),
    )
    for (const { handler, context } of calls) await handler(payload, context)
  }

  private async loadOne(
    path: string,
    canonicalPath: string,
    digest: string,
    rawBytes: Buffer,
  ): Promise<ExtensionActivation> {
    const source = rawBytes.toString("utf8")
    const trusted = new Set(this.options.trustedCapabilities ?? [])
    const staticCapabilities = staticDeclaredCapabilities(source)
    if (staticCapabilities !== undefined) {
      assertTrustedCapabilities(path, staticCapabilities, trusted)
    }
    // Reused activations never import again. New attempts need isolated module state, and serving the
    // verified in-memory source through Bun's loader prevents TOCTOU changes between preflight and eval.
    ensureExtensionSnapshotLoader()
    const specifier = `${canonicalPath}?nifraExtensionRevision=${++activationSequence}`
    extensionSnapshots.set(specifier, {
      contents: source,
      loader: extensionLoaderFor(canonicalPath),
    })
    let module: {
      default?: ExtensionFactory
      id?: string
      capabilities?: readonly string[]
    }
    try {
      module = (await import(specifier)) as {
        default?: ExtensionFactory
        id?: string
        capabilities?: readonly string[]
      }
    } finally {
      extensionSnapshots.delete(specifier)
    }
    if (typeof module.default !== "function")
      throw new Error(`extension ${path} has no default factory`)
    const capabilities = Object.freeze([...(module.capabilities ?? [])])
    assertTrustedCapabilities(path, capabilities, trusted)
    const registrations = createRegistrations()
    const own = this.context(registrations)
    let activation: ExtensionActivation | undefined
    // The factory and its callbacks keep these. The live registry goes first, so a name another
    // extension holds is refused before this one records it.
    const context: ExtensionContext = {
      cwd: own.cwd,
      registerCommand: (name, handler) => {
        activation?.live?.registerCommand(name, handler)
        own.registerCommand(name, handler)
      },
      registerTool: (tool) => {
        activation?.live?.registerTool(tool)
        own.registerTool(tool)
      },
      registerWorkflow: (name, workflow) => {
        activation?.live?.registerWorkflow(name, workflow)
        own.registerWorkflow(name, workflow)
      },
      registerSubagent: (role) => {
        activation?.live?.registerSubagent(role)
        own.registerSubagent(role)
      },
      registerProvider: (provider) => {
        activation?.live?.registerProvider(provider)
        own.registerProvider(provider)
      },
      on: (event, handler) => {
        activation?.live?.on(event, handler)
        own.on(event, handler)
      },
    }
    const result = await module.default(context)
    const extension = Object.freeze({
      id: module.id ?? path,
      path,
      capabilities,
      ...(result && typeof result === "object" && typeof result.dispose === "function"
        ? { dispose: result.dispose }
        : {}),
    })
    activation = { extension, digest, registrations, context, live: undefined }
    return activation
  }

  private context(registrations: ExtensionRegistrations): ExtensionContext {
    const { commands, tools, workflows, subagents, providers, handlers } = registrations
    return {
      cwd: this.options.cwd,
      registerCommand: (name, handler) => {
        if (!/^[a-z][a-z0-9._-]{0,63}$/.test(name))
          throw new Error(`invalid extension command: ${name}`)
        if (commands.has(name)) throw new Error(`duplicate extension command: ${name}`)
        commands.set(name, handler)
      },
      registerTool: (tool) => {
        if (!/^[a-z][a-z0-9._-]{0,63}$/.test(tool.name))
          throw new Error(`invalid extension tool: ${tool.name}`)
        if (tools.has(tool.name)) throw new Error(`duplicate extension tool: ${tool.name}`)
        const denied = (tool.capabilities ?? []).find(
          (capability) => !(this.options.trustedCapabilities ?? []).includes(capability),
        )
        if (denied !== undefined)
          throw new Error(`extension tool ${tool.name} requires untrusted capability: ${denied}`)
        tools.set(tool.name, tool)
      },
      registerWorkflow: (name, workflow) => {
        if (!/^[a-z][a-z0-9._-]{0,63}$/.test(name))
          throw new Error(`invalid extension workflow: ${name}`)
        if (workflows.has(name)) throw new Error(`duplicate extension workflow: ${name}`)
        workflows.set(name, workflow)
      },
      registerSubagent: (role) => {
        if (!/^[a-z][a-z0-9._-]{0,63}$/.test(role.name))
          throw new Error(`invalid extension subagent: ${role.name}`)
        if (subagents.has(role.name)) throw new Error(`duplicate extension subagent: ${role.name}`)
        subagents.set(role.name, Object.freeze({ ...role }))
      },
      registerProvider: (provider) => {
        if (!/^[a-z][a-z0-9._-]{0,63}$/.test(provider.name))
          throw new Error(`invalid extension provider: ${provider.name}`)
        if (providers.has(provider.name))
          throw new Error(`duplicate extension provider: ${provider.name}`)
        providers.set(provider.name, Object.freeze({ ...provider }))
      },
      on: (event, handler) => {
        if (!/^[a-z][a-z0-9._-]{0,63}$/.test(event))
          throw new Error(`invalid extension event: ${event}`)
        const current = handlers.get(event) ?? []
        handlers.set(event, [...current, handler])
      },
    }
  }
}

type CapabilityToken =
  | {
      readonly kind: "word"
      readonly text: string
      readonly depth: number
      readonly line: number
    }
  | {
      readonly kind: "string"
      readonly value: string
      readonly depth: number
      readonly line: number
    }
  | {
      readonly kind: "punct"
      readonly text: string
      readonly depth: number
      readonly line: number
      readonly regexNext?: boolean
    }
  | {
      readonly kind: "other"
      readonly text: string
      readonly depth: number
      readonly line: number
    }

const REGEX_PREFIX_KEYWORDS = new Set([
  "return",
  "throw",
  "case",
  "delete",
  "void",
  "typeof",
  "await",
  "yield",
  "in",
  "instanceof",
  "new",
  "export",
  "default",
  "else",
  "do",
])

const NON_REGEX_PUNCT = new Set(["]", "++", "--"])
const REGEX_AFTER_PAREN_KEYWORDS = new Set(["if", "while", "for", "with"])
const EXPR_BRACE_PREFIX_WORDS = new Set([
  "return",
  "throw",
  "yield",
  "await",
  "typeof",
  "void",
  "delete",
  "in",
  "of",
  "instanceof",
  "new",
  "case",
])
const EXPR_BRACE_PREFIX_PUNCT = new Set([
  "=",
  ":",
  "(",
  "[",
  ",",
  "?",
  "!",
  "~",
  "+",
  "-",
  "*",
  "%",
  "&",
  "|",
  "^",
  "<",
  ">",
])
const STATEMENT_PREFIX_WORDS = new Set([
  "export",
  "import",
  "const",
  "let",
  "var",
  "function",
  "class",
  "if",
  "for",
  "while",
  "do",
  "switch",
  "try",
  "return",
  "throw",
  "break",
  "continue",
  "type",
  "interface",
])
const TYPE_CONTINUATION_BEFORE = new Set(["|", "&", "=>", "<", ":", "(", "[", "{", ","])
const TYPE_CONTINUATION_WORDS = new Set([
  "keyof",
  "typeof",
  "readonly",
  "infer",
  "extends",
  "is",
  "asserts",
  "unique",
])
const INFIX_BEFORE_NEWLINE = new Set([
  ".",
  "?.",
  "=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "&",
  "|",
  "^",
  "?",
  ":",
  "&&",
  "||",
  "??",
  ",",
  "(",
  "[",
  "<",
  ">",
])
const INFIX_AFTER_NEWLINE = new Set([
  ".",
  "?.",
  "[",
  "(",
  "as",
  "satisfies",
  "?",
  ":",
  "&&",
  "||",
  "??",
  "+",
  "-",
  "*",
  "/",
  "%",
])

function isLineTerminatorCode(code: number): boolean {
  return code === 10 || code === 13 || code === 0x2028 || code === 0x2029
}

function isWhitespaceCode(code: number): boolean {
  return (
    code === 32 ||
    code === 9 ||
    code === 11 ||
    code === 12 ||
    isLineTerminatorCode(code) ||
    code === 0xfeff ||
    code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  )
}

function isWordStartCode(code: number): boolean {
  if (code > 127) return !isWhitespaceCode(code)
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36
}

function isWordContinueCode(code: number): boolean {
  return isWordStartCode(code) || (code >= 48 && code <= 57)
}

function isHexDigitCode(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102)
}

function decodeHexRange(
  source: string,
  start: number,
  end: number,
): { readonly valid: boolean; readonly ch: string } {
  if (end <= start || end > source.length) return { valid: false, ch: "" }
  let cp = 0
  for (let idx = start; idx < end; idx++) {
    const code = source.charCodeAt(idx)
    if (!isHexDigitCode(code)) return { valid: false, ch: "" }
    const digit = code <= 57 ? code - 48 : code <= 70 ? code - 55 : code - 87
    cp = cp * 16 + digit
    if (cp > 0x10ffff) return { valid: false, ch: "" }
  }
  return { valid: true, ch: String.fromCodePoint(cp) }
}

function decodeStringEscape(
  source: string,
  escapeIndex: number,
): {
  readonly ch: string
  readonly valid: boolean
  readonly nextIndex: number
  readonly lineDelta: number
} {
  const esc = source[escapeIndex + 1]
  if (esc === undefined) {
    return { ch: "", valid: false, nextIndex: escapeIndex + 1, lineDelta: 0 }
  }
  if (esc === "\r") {
    return {
      ch: "",
      valid: true,
      nextIndex: source[escapeIndex + 2] === "\n" ? escapeIndex + 3 : escapeIndex + 2,
      lineDelta: 1,
    }
  }
  if (esc === "\n" || esc === "\u2028" || esc === "\u2029") {
    return { ch: "", valid: true, nextIndex: escapeIndex + 2, lineDelta: 1 }
  }
  const simple: Record<string, string> = {
    n: "\n",
    r: "\r",
    t: "\t",
    b: "\b",
    f: "\f",
    v: "\v",
    "0": "\0",
  }
  if (esc in simple) {
    return { ch: simple[esc] ?? esc, valid: true, nextIndex: escapeIndex + 2, lineDelta: 0 }
  }
  if (esc === "x") {
    const hex = decodeHexRange(source, escapeIndex + 2, escapeIndex + 4)
    return hex.valid
      ? { ch: hex.ch, valid: true, nextIndex: escapeIndex + 4, lineDelta: 0 }
      : { ch: "", valid: false, nextIndex: escapeIndex + 2, lineDelta: 0 }
  }
  if (esc === "u") {
    if (source[escapeIndex + 2] === "{") {
      // Forward scan stops at the first non-hex character or closing brace, preventing quadratic scans.
      let cursor = escapeIndex + 3
      while (cursor < source.length && isHexDigitCode(source.charCodeAt(cursor))) cursor++
      if (cursor > escapeIndex + 3 && source[cursor] === "}") {
        const hex = decodeHexRange(source, escapeIndex + 3, cursor)
        return hex.valid
          ? { ch: hex.ch, valid: true, nextIndex: cursor + 1, lineDelta: 0 }
          : { ch: "", valid: false, nextIndex: cursor + 1, lineDelta: 0 }
      }
      return { ch: "", valid: false, nextIndex: escapeIndex + 3, lineDelta: 0 }
    }
    const hex = decodeHexRange(source, escapeIndex + 2, escapeIndex + 6)
    return hex.valid
      ? { ch: hex.ch, valid: true, nextIndex: escapeIndex + 6, lineDelta: 0 }
      : { ch: "", valid: false, nextIndex: escapeIndex + 2, lineDelta: 0 }
  }
  return { ch: esc, valid: true, nextIndex: escapeIndex + 2, lineDelta: 0 }
}

function scanQuotedString(
  source: string,
  start: number,
): {
  readonly value: string
  readonly valid: boolean
  readonly nextIndex: number
  readonly lineDelta: number
} {
  const quote = source[start]
  let value = ""
  let valid = true
  let lineDelta = 0
  let idx = start + 1
  while (idx < source.length) {
    const ch = source[idx]
    if (ch === quote) return { value, valid, nextIndex: idx + 1, lineDelta }
    if (ch === "\\") {
      const decoded = decodeStringEscape(source, idx)
      if (!decoded.valid) valid = false
      value += decoded.ch
      lineDelta += decoded.lineDelta
      idx = decoded.nextIndex
      continue
    }
    if (ch === "\r") {
      lineDelta++
      value += ch
      idx += source[idx + 1] === "\n" ? 2 : 1
      continue
    }
    if (ch === "\n") lineDelta++
    value += ch
    idx++
  }
  return { value, valid: false, nextIndex: idx, lineDelta }
}

function scanTemplateSegment(
  source: string,
  start: number,
): {
  readonly value: string
  readonly valid: boolean
  readonly interpolated: boolean
  readonly nextIndex: number
  readonly lineDelta: number
} {
  let value = ""
  let valid = true
  let lineDelta = 0
  let idx = start
  while (idx < source.length) {
    const ch = source[idx]
    if (ch === "`") return { value, valid, interpolated: false, nextIndex: idx + 1, lineDelta }
    if (ch === "$" && source[idx + 1] === "{") {
      return { value, valid, interpolated: true, nextIndex: idx + 2, lineDelta }
    }
    if (ch === "\\") {
      const decoded = decodeStringEscape(source, idx)
      if (!decoded.valid) valid = false
      value += decoded.ch
      lineDelta += decoded.lineDelta
      idx = decoded.nextIndex
      continue
    }
    if (ch === "\r") {
      lineDelta++
      value += "\n"
      idx += source[idx + 1] === "\n" ? 2 : 1
      continue
    }
    if (ch === "\n" || ch === "\u2028" || ch === "\u2029") lineDelta++
    value += ch
    idx++
  }
  return { value, valid: false, interpolated: false, nextIndex: idx, lineDelta }
}

function scanRegexLiteral(source: string, start: number): number {
  let idx = start + 1
  let inClass = false
  while (idx < source.length) {
    const ch = source[idx]
    if (ch === "\\") {
      if (idx + 1 < source.length && isLineTerminatorCode(source.charCodeAt(idx + 1))) {
        return idx + 1
      }
      idx += 2
      continue
    }
    if (ch === "[") {
      inClass = true
      idx++
      continue
    }
    if (ch === "]" && inClass) {
      inClass = false
      idx++
      continue
    }
    if (ch === "/" && !inClass) {
      idx++
      while (idx < source.length && isWordContinueCode(source.charCodeAt(idx))) idx++
      return idx
    }
    if (isLineTerminatorCode(source.charCodeAt(idx))) return idx
    idx++
  }
  return idx
}

function canStartRegex(prev: CapabilityToken | undefined, inForParen: boolean): boolean {
  if (prev === undefined) return true
  if (prev.kind === "word") {
    if (prev.text === "of") return inForParen
    return REGEX_PREFIX_KEYWORDS.has(prev.text)
  }
  if (prev.kind === "punct") {
    if (prev.regexNext !== undefined) return prev.regexNext
    return !NON_REGEX_PUNCT.has(prev.text)
  }
  return false
}

function isExpressionOpeningBrace(
  prev: CapabilityToken | undefined,
  inTypeAlias: boolean,
): boolean {
  if (inTypeAlias || prev === undefined) return false
  if (prev.kind === "word") return EXPR_BRACE_PREFIX_WORDS.has(prev.text)
  if (prev.kind === "punct") return EXPR_BRACE_PREFIX_PUNCT.has(prev.text)
  return false
}

function tokenizeModuleSource(source: string): CapabilityToken[] {
  const tokens: CapabilityToken[] = []
  const templateBraceDepths: number[] = []
  const braceExprStack: boolean[] = []
  const parenKindStack: Array<"control" | "for" | "expr"> = []
  let braceDepth = 0
  let bracketDepth = 0
  let parenDepth = 0
  let inTypeAlias = false
  let line = 1
  const depth = (): number => braceDepth + bracketDepth + parenDepth
  let idx = 0

  while (idx < source.length) {
    const code = source.charCodeAt(idx)
    if (isWhitespaceCode(code)) {
      if (code === 13) {
        line++
        idx += source[idx + 1] === "\n" ? 2 : 1
        continue
      }
      if (code === 10 || code === 0x2028 || code === 0x2029) line++
      idx++
      continue
    }
    const ch = source[idx]
    if (ch === "/" && source[idx + 1] === "/") {
      idx += 2
      while (idx < source.length && !isLineTerminatorCode(source.charCodeAt(idx))) idx++
      continue
    }
    if (ch === "/" && source[idx + 1] === "*") {
      idx += 2
      while (idx < source.length) {
        if (source[idx] === "*" && source[idx + 1] === "/") {
          idx += 2
          break
        }
        const c = source.charCodeAt(idx)
        if (c === 13) {
          line++
          idx += source[idx + 1] === "\n" ? 2 : 1
          continue
        }
        if (c === 10 || c === 0x2028 || c === 0x2029) line++
        idx++
      }
      continue
    }
    if (ch === "/" && canStartRegex(tokens.at(-1), parenKindStack.at(-1) === "for")) {
      tokens.push({ kind: "other", text: "/", depth: depth(), line })
      idx = scanRegexLiteral(source, idx)
      continue
    }
    if (ch === '"' || ch === "'") {
      const scanned = scanQuotedString(source, idx)
      tokens.push(
        scanned.valid
          ? { kind: "string", value: scanned.value, depth: depth(), line }
          : { kind: "other", text: ch, depth: depth(), line },
      )
      line += scanned.lineDelta
      idx = scanned.nextIndex
      continue
    }
    if (ch === "`") {
      const d = depth()
      const startLine = line
      const seg = scanTemplateSegment(source, idx + 1)
      line += seg.lineDelta
      if (!seg.interpolated) {
        tokens.push(
          seg.valid
            ? { kind: "string", value: seg.value, depth: d, line: startLine }
            : { kind: "other", text: "`", depth: d, line: startLine },
        )
        idx = seg.nextIndex
        continue
      }
      templateBraceDepths.push(braceDepth)
      braceExprStack.push(false)
      braceDepth++
      tokens.push({ kind: "punct", text: "${", depth: d, line: startLine, regexNext: true })
      idx = seg.nextIndex
      continue
    }
    if (ch === "}" && braceDepth > 0) {
      braceDepth--
      const d = depth()
      const exprBrace = braceExprStack.pop() ?? false
      if (d === 0) inTypeAlias = false
      if (templateBraceDepths.at(-1) === braceDepth) {
        templateBraceDepths.pop()
        const seg = scanTemplateSegment(source, idx + 1)
        const segLine = line
        line += seg.lineDelta
        if (seg.interpolated) {
          templateBraceDepths.push(braceDepth)
          braceExprStack.push(false)
          braceDepth++
          tokens.push({ kind: "punct", text: "${", depth: d, line: segLine, regexNext: true })
        } else {
          tokens.push({ kind: "other", text: "`", depth: d, line: segLine })
        }
        idx = seg.nextIndex
        continue
      }
      tokens.push({ kind: "punct", text: "}", depth: d, line, regexNext: !exprBrace })
      idx++
      continue
    }
    if (ch === "{") {
      const d = depth()
      braceExprStack.push(isExpressionOpeningBrace(tokens.at(-1), inTypeAlias))
      tokens.push({ kind: "punct", text: "{", depth: d, line })
      braceDepth++
      idx++
      continue
    }
    if (ch === "[") {
      tokens.push({ kind: "punct", text: "[", depth: depth(), line })
      bracketDepth++
      idx++
      continue
    }
    if (ch === "]") {
      if (bracketDepth > 0) bracketDepth--
      tokens.push({ kind: "punct", text: "]", depth: depth(), line })
      idx++
      continue
    }
    if (ch === "(") {
      const prev = tokens.at(-1)
      const beforePrev = tokens.at(-2)
      let pKind: "control" | "for" | "expr" = "expr"
      if (prev?.kind === "word") {
        if (
          prev.text === "for" ||
          (prev.text === "await" && beforePrev?.kind === "word" && beforePrev.text === "for")
        ) {
          pKind = "for"
        } else if (REGEX_AFTER_PAREN_KEYWORDS.has(prev.text)) {
          pKind = "control"
        }
      }
      parenKindStack.push(pKind)
      tokens.push({ kind: "punct", text: "(", depth: depth(), line })
      parenDepth++
      idx++
      continue
    }
    if (ch === ")") {
      if (parenDepth > 0) parenDepth--
      const pKind = parenKindStack.pop() ?? "expr"
      tokens.push({
        kind: "punct",
        text: ")",
        depth: depth(),
        line,
        regexNext: pKind === "control" || pKind === "for",
      })
      idx++
      continue
    }
    if (isWordStartCode(code)) {
      const start = idx
      idx++
      while (idx < source.length && isWordContinueCode(source.charCodeAt(idx))) idx++
      const word = source.slice(start, idx)
      const d = depth()
      if (d === 0 && (word === "type" || word === "interface")) {
        const prev = tokens.at(-1)
        if (
          prev === undefined ||
          prev.line < line ||
          (prev.kind === "punct" && (prev.text === ";" || prev.text === "}")) ||
          (prev.kind === "word" && prev.text === "export")
        ) {
          inTypeAlias = true
        }
      }
      tokens.push({ kind: "word", text: word, depth: d, line })
      continue
    }
    if (code >= 48 && code <= 57) {
      const start = idx
      idx++
      while (idx < source.length) {
        const c = source.charCodeAt(idx)
        if (
          isWordContinueCode(c) ||
          c === 46 ||
          ((c === 43 || c === 45) && (source[idx - 1] === "e" || source[idx - 1] === "E"))
        ) {
          idx++
          continue
        }
        break
      }
      tokens.push({ kind: "other", text: source.slice(start, idx), depth: depth(), line })
      continue
    }
    if (ch === ";" && depth() === 0) inTypeAlias = false
    const three = source.slice(idx, idx + 3)
    if (three === "===" || three === "!==") {
      tokens.push({ kind: "punct", text: three, depth: depth(), line })
      idx += 3
      continue
    }
    const two = source.slice(idx, idx + 2)
    if (
      two === "=>" ||
      two === "==" ||
      two === "!=" ||
      two === "++" ||
      two === "--" ||
      two === "?."
    ) {
      tokens.push({ kind: "punct", text: two, depth: depth(), line })
      idx += 2
      continue
    }
    tokens.push({ kind: "punct", text: ch ?? "", depth: depth(), line })
    idx++
  }

  return tokens
}

function readStringArrayLiteral(
  tokens: readonly CapabilityToken[],
  openIndex: number,
  expectedDepth: number,
): { readonly items: readonly string[]; readonly nextIndex: number } | undefined {
  const open = tokens[openIndex]
  if (open?.kind !== "punct" || open.text !== "[" || open.depth !== expectedDepth) {
    return undefined
  }
  const innerDepth = expectedDepth + 1
  const items: string[] = []
  let idx = openIndex + 1
  while (idx < tokens.length) {
    const token = tokens[idx]
    if (token === undefined) return undefined
    if (token.kind === "punct" && token.text === "]" && token.depth === expectedDepth) {
      return { items, nextIndex: idx + 1 }
    }
    if (token.kind !== "string" || token.depth !== innerDepth) return undefined
    items.push(token.value)
    idx++
    const sep = tokens[idx]
    if (sep?.kind === "punct" && sep.text === "]" && sep.depth === expectedDepth) {
      return { items, nextIndex: idx + 1 }
    }
    if (sep?.kind === "punct" && sep.text === "," && sep.depth === innerDepth) {
      idx++
      continue
    }
    return undefined
  }
  return undefined
}

function continuesTypeAnnotationAcrossNewline(
  prev: CapabilityToken,
  cur: CapabilityToken,
): boolean {
  if (prev.kind === "punct" && TYPE_CONTINUATION_BEFORE.has(prev.text)) return true
  if (prev.kind === "word" && TYPE_CONTINUATION_WORDS.has(prev.text)) return true
  if (cur.kind === "punct" && (cur.text === "|" || cur.text === "&" || cur.text === "=>")) {
    return true
  }
  return false
}

function skipTypeAnnotation(tokens: readonly CapabilityToken[], start: number): number {
  let idx = start
  let angleDepth = 0
  while (idx < tokens.length) {
    const tok = tokens[idx]
    if (tok === undefined) return idx
    if (tok.depth === 0 && angleDepth === 0) {
      if (tok.kind === "punct" && (tok.text === "=" || tok.text === "," || tok.text === ";")) {
        return idx
      }
      if (idx > start) {
        const prev = tokens[idx - 1]
        if (
          prev !== undefined &&
          tok.line > prev.line &&
          !continuesTypeAnnotationAcrossNewline(prev, tok)
        ) {
          return idx
        }
      }
    }
    if (tok.kind === "punct") {
      if (tok.text === "<") angleDepth++
      else if (tok.text === ">" && angleDepth > 0) angleDepth--
    }
    idx++
  }
  return idx
}

function continuesExpressionAcrossNewline(prev: CapabilityToken, cur: CapabilityToken): boolean {
  if (prev.kind === "punct" && INFIX_BEFORE_NEWLINE.has(prev.text)) return true
  if (prev.kind === "word" && (prev.text === "as" || prev.text === "satisfies")) return true
  if (cur.kind === "punct" && INFIX_AFTER_NEWLINE.has(cur.text)) return true
  if (cur.kind === "word" && (cur.text === "as" || cur.text === "satisfies")) return true
  return false
}

function findInitializerEnd(tokens: readonly CapabilityToken[], start: number): number {
  let idx = start
  while (idx < tokens.length) {
    const tok = tokens[idx]
    if (tok === undefined) return idx
    if (tok.depth === 0) {
      if (tok.kind === "punct" && (tok.text === "," || tok.text === ";" || tok.text === "}")) {
        return idx
      }
      if (idx > start) {
        const prev = tokens[idx - 1]
        if (
          prev !== undefined &&
          tok.line > prev.line &&
          !continuesExpressionAcrossNewline(prev, tok)
        ) {
          return idx
        }
      }
    }
    idx++
  }
  return idx
}

function isAllowedTypeSuffixOnly(
  tokens: readonly CapabilityToken[],
  start: number,
  end: number,
): boolean {
  if (start === end) return true
  const first = tokens[start]
  return first?.kind === "word" && (first.text === "as" || first.text === "satisfies")
}

const DECL_BINDING_KEYWORDS = new Set(["const", "let", "var"])

function patternContainsName(
  tokens: readonly CapabilityToken[],
  start: number,
  end: number,
  name: string,
): boolean {
  for (let i = start; i < end; i++) {
    const tok = tokens[i]
    if (tok?.kind !== "word" || tok.text !== name) continue
    const next = tokens[i + 1]
    // `{ Object: alias }` renames property `Object` into `alias`; it does not bind `Object`.
    if (next?.kind === "punct" && next.text === ":") continue
    return true
  }
  return false
}

function scanMatchingParenEnd(tokens: readonly CapabilityToken[], openIndex: number): number {
  const open = tokens[openIndex]
  if (open?.kind !== "punct" || open.text !== "(") return openIndex
  const targetDepth = open.depth
  for (let i = openIndex + 1; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok?.kind === "punct" && tok.text === ")" && tok.depth === targetDepth) return i
  }
  return tokens.length - 1
}

function isObjectGlobalShadowed(tokens: readonly CapabilityToken[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok === undefined) continue
    if (tok.kind === "word" && tok.text === "Object") {
      const prev = tokens[i - 1]
      const next = tokens[i + 1]
      const next2 = tokens[i + 2]
      const next3 = tokens[i + 3]
      // Direct reassignment: `Object = ...`, `globalThis.Object = ...`, or `Object.freeze = ...`.
      if (next?.kind === "punct" && next.text === "=") return true
      if (
        !(prev?.kind === "punct" && (prev.text === "." || prev.text === "?.")) &&
        next?.kind === "punct" &&
        next.text === "." &&
        next2?.kind === "word" &&
        next2.text === "freeze" &&
        next3?.kind === "punct" &&
        next3.text === "="
      ) {
        return true
      }
      if (
        prev?.kind === "word" &&
        (prev.text === "function" || prev.text === "class" || prev.text === "catch")
      ) {
        return true
      }
      const genPrev = tokens[i - 2]
      if (
        prev?.kind === "punct" &&
        prev.text === "*" &&
        genPrev?.kind === "word" &&
        genPrev.text === "function"
      ) {
        return true
      }
    }
    if (tok.kind === "word" && tok.text === "import") {
      for (let j = i + 1; j < tokens.length; j++) {
        const cur = tokens[j]
        if (cur === undefined) break
        if (cur.kind === "word" && cur.text === "from") break
        if (cur.kind === "punct" && cur.text === ";") break
        if (cur.kind === "word" && cur.text === "Object") {
          const after = tokens[j + 1]
          if (!(after?.kind === "word" && after.text === "as")) return true
        }
      }
    }
    if (tok.kind === "word" && DECL_BINDING_KEYWORDS.has(tok.text)) {
      const baseDepth = tok.depth
      let pos = i + 1
      while (pos < tokens.length) {
        const cur = tokens[pos]
        if (cur === undefined || cur.depth < baseDepth) break
        // Pattern spans until top-level `:`, `=`, `,`, `;`, or statement boundary.
        let patEnd = pos
        while (patEnd < tokens.length) {
          const t = tokens[patEnd]
          if (t === undefined || t.depth < baseDepth) break
          if (
            t.depth === baseDepth &&
            t.kind === "punct" &&
            (t.text === "=" || t.text === ":" || t.text === "," || t.text === ";")
          ) {
            break
          }
          const prevPat = patEnd > pos ? tokens[patEnd - 1] : undefined
          if (
            prevPat !== undefined &&
            t.depth === baseDepth &&
            t.line > prevPat.line &&
            !continuesExpressionAcrossNewline(prevPat, t)
          ) {
            break
          }
          patEnd++
        }
        if (patternContainsName(tokens, pos, patEnd, "Object")) return true
        pos = patEnd
        const colonTok = tokens[pos]
        if (colonTok?.depth === baseDepth && colonTok.kind === "punct" && colonTok.text === ":") {
          pos++
          while (pos < tokens.length) {
            const t = tokens[pos]
            if (t === undefined || t.depth < baseDepth) break
            if (
              t.depth === baseDepth &&
              t.kind === "punct" &&
              (t.text === "=" || t.text === "," || t.text === ";")
            ) {
              break
            }
            pos++
          }
        }
        const assignTok = tokens[pos]
        if (
          assignTok?.depth === baseDepth &&
          assignTok.kind === "punct" &&
          assignTok.text === "="
        ) {
          pos++
          while (pos < tokens.length) {
            const t = tokens[pos]
            if (t === undefined || t.depth < baseDepth) break
            if (t.depth === baseDepth && t.kind === "punct" && (t.text === "," || t.text === ";")) {
              break
            }
            const prevInit = tokens[pos - 1]
            if (
              t.depth === baseDepth &&
              prevInit !== undefined &&
              t.line > prevInit.line &&
              !continuesExpressionAcrossNewline(prevInit, t)
            ) {
              break
            }
            pos++
          }
        }
        const nextDeclTok = tokens[pos]
        if (
          nextDeclTok?.depth === baseDepth &&
          nextDeclTok.kind === "punct" &&
          nextDeclTok.text === ","
        ) {
          pos++
          continue
        }
        break
      }
    }
    if (tok.kind === "punct" && tok.text === "(") {
      const prev = tokens[i - 1]
      const beforePrev = tokens[i - 2]
      const closeIdx = scanMatchingParenEnd(tokens, i)
      const afterClose = tokens[closeIdx + 1]
      const isFunctionOrArrow =
        (prev?.kind === "word" &&
          (prev.text === "function" ||
            prev.text === "catch" ||
            (beforePrev?.kind === "word" && beforePrev.text === "function"))) ||
        (afterClose?.kind === "punct" && afterClose.text === "=>")
      if (isFunctionOrArrow && patternContainsName(tokens, i + 1, closeIdx, "Object")) {
        return true
      }
    }
  }
  return false
}

function readDeclaratorCapabilities(
  tokens: readonly CapabilityToken[],
  rhsStart: number,
  initEnd: number,
  objectShadowed: boolean,
): readonly string[] | undefined {
  const direct = readStringArrayLiteral(tokens, rhsStart, 0)
  if (direct !== undefined && isAllowedTypeSuffixOnly(tokens, direct.nextIndex, initEnd)) {
    return direct.items
  }
  if (!objectShadowed && rhsStart + 4 < initEnd) {
    const t0 = tokens[rhsStart]
    const t1 = tokens[rhsStart + 1]
    const t2 = tokens[rhsStart + 2]
    const t3 = tokens[rhsStart + 3]
    if (
      t0?.kind === "word" &&
      t0.text === "Object" &&
      t1?.kind === "punct" &&
      t1.text === "." &&
      t2?.kind === "word" &&
      t2.text === "freeze" &&
      t3?.kind === "punct" &&
      t3.text === "("
    ) {
      const frozen = readStringArrayLiteral(tokens, rhsStart + 4, 1)
      const closeParen = frozen !== undefined ? tokens[frozen.nextIndex] : undefined
      if (
        frozen !== undefined &&
        closeParen?.kind === "punct" &&
        closeParen.text === ")" &&
        closeParen.depth === 0 &&
        isAllowedTypeSuffixOnly(tokens, frozen.nextIndex + 1, initEnd)
      ) {
        return frozen.items
      }
    }
  }
  return undefined
}

function staticDeclaredCapabilities(source: string): readonly string[] | undefined {
  const tokens = tokenizeModuleSource(source)
  const objectShadowed = isObjectGlobalShadowed(tokens)
  for (let i = 0; i < tokens.length - 3; i++) {
    const prevTok = i > 0 ? tokens[i - 1] : undefined
    if (prevTok?.kind === "punct" && (prevTok.text === "." || prevTok.text === "?.")) {
      continue
    }
    const exportTok = tokens[i]
    const declTok = tokens[i + 1]
    // Restrict preflight to `export const` so mutable `let`/`var` bindings reassigned before return
    // defer to the post-import runtime check.
    if (
      exportTok?.kind !== "word" ||
      exportTok.text !== "export" ||
      exportTok.depth !== 0 ||
      declTok?.kind !== "word" ||
      declTok.text !== "const" ||
      declTok.depth !== 0
    ) {
      continue
    }
    let pos = i + 2
    while (pos < tokens.length) {
      const nameTok = tokens[pos]
      if (nameTok === undefined || nameTok.depth !== 0) break
      if (nameTok.kind === "punct" && (nameTok.text === "{" || nameTok.text === "[")) {
        let pat = pos + 1
        while (pat < tokens.length && (tokens[pat]?.depth ?? 0) > 0) pat++
        const afterPat = tokens[pat]
        if (afterPat?.kind === "punct" && afterPat.text === ":")
          pat = skipTypeAnnotation(tokens, pat + 1)
        const patEq = tokens[pat]
        if (patEq?.kind !== "punct" || patEq.text !== "=") break
        pos = findInitializerEnd(tokens, pat + 1)
        const nextSep = tokens[pos]
        if (nextSep?.depth === 0 && nextSep.kind === "punct" && nextSep.text === ",") {
          pos++
          continue
        }
        break
      }
      if (nameTok.kind !== "word" || STATEMENT_PREFIX_WORDS.has(nameTok.text)) break
      const ident = nameTok.text
      pos++
      const typeColon = tokens[pos]
      if (typeColon?.depth === 0 && typeColon.kind === "punct" && typeColon.text === ":") {
        pos = skipTypeAnnotation(tokens, pos + 1)
      }
      const eqTok = tokens[pos]
      if (eqTok?.depth !== 0 || eqTok.kind !== "punct" || eqTok.text !== "=") {
        if (eqTok?.depth === 0 && eqTok.kind === "punct" && eqTok.text === ",") {
          pos++
          continue
        }
        break
      }
      const rhsStart = pos + 1
      const initEnd = findInitializerEnd(tokens, rhsStart)
      if (ident === "capabilities") {
        return readDeclaratorCapabilities(tokens, rhsStart, initEnd, objectShadowed)
      }
      pos = initEnd
      const sepTok = tokens[pos]
      if (sepTok?.depth === 0 && sepTok.kind === "punct" && sepTok.text === ",") {
        pos++
        continue
      }
      break
    }
  }
  return undefined
}

function assertTrustedCapabilities(
  path: string,
  capabilities: readonly string[],
  trusted: ReadonlySet<string>,
): void {
  const denied = capabilities.find((capability) => !trusted.has(capability))
  if (denied !== undefined) {
    throw new Error(`extension ${path} requires untrusted capability: ${denied}`)
  }
}

function isWithin(root: string, candidate: string): boolean {
  const canonical = (path: string): string => {
    try {
      return realpathSync(path)
    } catch {
      return resolve(path)
    }
  }
  const relativePath = relative(canonical(root), canonical(candidate))
  // On Windows a path on another drive has no relative form, so `relative` returns it absolute.
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  )
}
