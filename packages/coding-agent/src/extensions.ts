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
        const digest = createHash("sha256").update(readFileSync(path)).digest("hex")
        let activation = this.activations.find(
          (candidate) =>
            candidate.extension.path === path &&
            candidate.digest === digest &&
            !next.includes(candidate),
        )
        if (activation === undefined) {
          activation = await this.loadOne(path, digest)
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

  private async loadOne(path: string, digest: string): Promise<ExtensionActivation> {
    const source = readFileSync(path, "utf8")
    const trusted = new Set(this.options.trustedCapabilities ?? [])
    const staticCapabilities = staticDeclaredCapabilities(source)
    if (staticCapabilities !== undefined) {
      assertTrustedCapabilities(path, staticCapabilities, trusted)
    }
    // Reused activations never import again. New attempts need isolated module state, and a failed
    // evaluation can stay cached for the URL used by that attempt.
    const module = (await import(`${path}?revision=${++activationSequence}`)) as {
      default?: ExtensionFactory
      id?: string
      capabilities?: readonly string[]
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
  | { readonly kind: "word"; readonly text: string; readonly depth: number }
  | { readonly kind: "string"; readonly value: string; readonly depth: number }
  | {
      readonly kind: "punct"
      readonly text: string
      readonly depth: number
      readonly regexNext?: boolean
    }
  | { readonly kind: "other"; readonly text: string; readonly depth: number }

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
  "of",
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
const EXPORT_DECL_KEYWORDS = new Set(["const", "let", "var"])

function isWordStartCode(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 36 ||
    code > 127
  )
}

function isWordContinueCode(code: number): boolean {
  return isWordStartCode(code) || (code >= 48 && code <= 57)
}

function isWhitespaceCode(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 11 || code === 12
}

function decodeHexEscape(
  source: string,
  start: number,
  digits: number,
): { readonly ch: string; readonly nextIndex: number } | undefined {
  if (start + digits > source.length) return undefined
  const slice = source.slice(start, start + digits)
  for (let idx = 0; idx < slice.length; idx++) {
    const code = slice.charCodeAt(idx)
    const hex =
      (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102)
    if (!hex) return undefined
  }
  return {
    ch: String.fromCodePoint(Number.parseInt(slice, 16)),
    nextIndex: start + digits,
  }
}

function decodeStringEscape(
  source: string,
  escapeIndex: number,
): { readonly ch: string; readonly nextIndex: number } {
  const esc = source[escapeIndex + 1]
  if (esc === undefined) return { ch: "", nextIndex: escapeIndex + 1 }
  if (esc === "\r") {
    return {
      ch: "",
      nextIndex: source[escapeIndex + 2] === "\n" ? escapeIndex + 3 : escapeIndex + 2,
    }
  }
  if (esc === "\n") return { ch: "", nextIndex: escapeIndex + 2 }
  const simple: Record<string, string> = {
    n: "\n",
    r: "\r",
    t: "\t",
    b: "\b",
    f: "\f",
    v: "\v",
    "0": "\0",
  }
  if (esc in simple) return { ch: simple[esc] ?? esc, nextIndex: escapeIndex + 2 }
  if (esc === "x") {
    const hex = decodeHexEscape(source, escapeIndex + 2, 2)
    if (hex !== undefined) return hex
  }
  if (esc === "u") {
    if (source[escapeIndex + 2] === "{") {
      const close = source.indexOf("}", escapeIndex + 3)
      if (close !== -1 && close > escapeIndex + 3) {
        const hex = decodeHexEscape(source, escapeIndex + 3, close - (escapeIndex + 3))
        if (hex !== undefined) return { ch: hex.ch, nextIndex: close + 1 }
      }
    } else {
      const hex = decodeHexEscape(source, escapeIndex + 2, 4)
      if (hex !== undefined) return hex
    }
  }
  return { ch: esc, nextIndex: escapeIndex + 2 }
}

function scanQuotedString(
  source: string,
  start: number,
): { readonly value: string; readonly nextIndex: number } {
  const quote = source[start]
  let value = ""
  let idx = start + 1
  while (idx < source.length) {
    const ch = source[idx]
    if (ch === quote) return { value, nextIndex: idx + 1 }
    if (ch === "\\") {
      const decoded = decodeStringEscape(source, idx)
      value += decoded.ch
      idx = decoded.nextIndex
      continue
    }
    value += ch
    idx++
  }
  return { value, nextIndex: idx }
}

function scanTemplateSegment(
  source: string,
  start: number,
): { readonly value: string; readonly interpolated: boolean; readonly nextIndex: number } {
  let value = ""
  let idx = start
  while (idx < source.length) {
    const ch = source[idx]
    if (ch === "`") return { value, interpolated: false, nextIndex: idx + 1 }
    if (ch === "$" && source[idx + 1] === "{") {
      return { value, interpolated: true, nextIndex: idx + 2 }
    }
    if (ch === "\\") {
      const decoded = decodeStringEscape(source, idx)
      value += decoded.ch
      idx = decoded.nextIndex
      continue
    }
    value += ch
    idx++
  }
  return { value, interpolated: false, nextIndex: idx }
}

function scanRegexLiteral(source: string, start: number): number {
  let idx = start + 1
  let inClass = false
  while (idx < source.length) {
    const ch = source[idx]
    if (ch === "\\") {
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
    if (ch === "\n" || ch === "\r") return idx
    idx++
  }
  return idx
}

function canStartRegex(prev: CapabilityToken | undefined): boolean {
  if (prev === undefined) return true
  if (prev.kind === "word") return REGEX_PREFIX_KEYWORDS.has(prev.text)
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
  const parenRegexStack: boolean[] = []
  let braceDepth = 0
  let bracketDepth = 0
  let parenDepth = 0
  let inTypeAlias = false
  const depth = (): number => braceDepth + bracketDepth + parenDepth
  let idx = 0

  while (idx < source.length) {
    const code = source.charCodeAt(idx)
    if (isWhitespaceCode(code)) {
      idx++
      continue
    }
    const ch = source[idx]
    if (ch === "/" && source[idx + 1] === "/") {
      const nl = source.indexOf("\n", idx + 2)
      idx = nl === -1 ? source.length : nl + 1
      continue
    }
    if (ch === "/" && source[idx + 1] === "*") {
      const end = source.indexOf("*/", idx + 2)
      idx = end === -1 ? source.length : end + 2
      continue
    }
    if (ch === "/" && canStartRegex(tokens.at(-1))) {
      tokens.push({ kind: "other", text: "/", depth: depth() })
      idx = scanRegexLiteral(source, idx)
      continue
    }
    if (ch === '"' || ch === "'") {
      const scanned = scanQuotedString(source, idx)
      tokens.push({ kind: "string", value: scanned.value, depth: depth() })
      idx = scanned.nextIndex
      continue
    }
    if (ch === "`") {
      const d = depth()
      const seg = scanTemplateSegment(source, idx + 1)
      if (!seg.interpolated) {
        tokens.push({ kind: "string", value: seg.value, depth: d })
        idx = seg.nextIndex
        continue
      }
      templateBraceDepths.push(braceDepth)
      braceExprStack.push(false)
      braceDepth++
      tokens.push({ kind: "other", text: "`${", depth: d })
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
        if (seg.interpolated) {
          templateBraceDepths.push(braceDepth)
          braceExprStack.push(false)
          braceDepth++
          tokens.push({ kind: "other", text: "${", depth: d })
        } else {
          tokens.push({ kind: "other", text: "`", depth: d })
        }
        idx = seg.nextIndex
        continue
      }
      tokens.push({ kind: "punct", text: "}", depth: d, regexNext: !exprBrace })
      idx++
      continue
    }
    if (ch === "{") {
      const d = depth()
      braceExprStack.push(isExpressionOpeningBrace(tokens.at(-1), inTypeAlias))
      tokens.push({ kind: "punct", text: "{", depth: d })
      braceDepth++
      idx++
      continue
    }
    if (ch === "[") {
      tokens.push({ kind: "punct", text: "[", depth: depth() })
      bracketDepth++
      idx++
      continue
    }
    if (ch === "]") {
      if (bracketDepth > 0) bracketDepth--
      tokens.push({ kind: "punct", text: "]", depth: depth() })
      idx++
      continue
    }
    if (ch === "(") {
      const prev = tokens.at(-1)
      parenRegexStack.push(prev?.kind === "word" && REGEX_AFTER_PAREN_KEYWORDS.has(prev.text))
      tokens.push({ kind: "punct", text: "(", depth: depth() })
      parenDepth++
      idx++
      continue
    }
    if (ch === ")") {
      if (parenDepth > 0) parenDepth--
      const regexNext = parenRegexStack.pop() ?? false
      tokens.push({ kind: "punct", text: ")", depth: depth(), regexNext })
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
          (prev.kind === "punct" && (prev.text === ";" || prev.text === "}")) ||
          (prev.kind === "word" && prev.text === "export")
        ) {
          inTypeAlias = true
        }
      }
      tokens.push({ kind: "word", text: word, depth: d })
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
      tokens.push({ kind: "other", text: source.slice(start, idx), depth: depth() })
      continue
    }
    if (ch === ";" && depth() === 0) inTypeAlias = false
    const two = source.slice(idx, idx + 2)
    if (two === "=>" || two === "==" || two === "++" || two === "--" || two === "?.") {
      tokens.push({ kind: "punct", text: two, depth: depth() })
      idx += 2
      continue
    }
    tokens.push({ kind: "punct", text: ch ?? "", depth: depth() })
    idx++
  }

  return tokens
}

function readStringArrayLiteral(
  tokens: readonly CapabilityToken[],
  openIndex: number,
  expectedDepth: number,
): readonly string[] | undefined {
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
      return items
    }
    if (token.kind !== "string" || token.depth !== innerDepth) return undefined
    items.push(token.value)
    idx++
    const sep = tokens[idx]
    if (sep?.kind === "punct" && sep.text === "]" && sep.depth === expectedDepth) {
      return items
    }
    if (sep?.kind === "punct" && sep.text === "," && sep.depth === innerDepth) {
      idx++
      continue
    }
    return undefined
  }
  return undefined
}

function staticDeclaredCapabilities(source: string): readonly string[] | undefined {
  const tokens = tokenizeModuleSource(source)
  for (let i = 0; i < tokens.length - 3; i++) {
    const prevTok = i > 0 ? tokens[i - 1] : undefined
    if (prevTok?.kind === "punct" && (prevTok.text === "." || prevTok.text === "?.")) {
      continue
    }
    const exportTok = tokens[i]
    const declTok = tokens[i + 1]
    const nameTok = tokens[i + 2]
    if (
      exportTok?.kind !== "word" ||
      exportTok.text !== "export" ||
      exportTok.depth !== 0 ||
      declTok?.kind !== "word" ||
      !EXPORT_DECL_KEYWORDS.has(declTok.text) ||
      declTok.depth !== 0 ||
      nameTok?.kind !== "word" ||
      nameTok.text !== "capabilities" ||
      nameTok.depth !== 0
    ) {
      continue
    }
    // Skip any TypeScript type annotation (`: readonly string[]`) up to the top-level `=`.
    let eqIdx = i + 3
    while (eqIdx < tokens.length) {
      const tok = tokens[eqIdx]
      if (tok === undefined) return undefined
      if (tok.depth === 0 && tok.kind === "punct" && tok.text === "=") break
      if (tok.depth === 0 && tok.kind === "punct" && (tok.text === ";" || tok.text === ",")) {
        eqIdx = -1
        break
      }
      eqIdx++
    }
    if (eqIdx === -1 || eqIdx + 1 >= tokens.length) continue
    const rhsStart = eqIdx + 1
    const direct = readStringArrayLiteral(tokens, rhsStart, 0)
    if (direct !== undefined) return direct
    // Also recognize `Object.freeze([...])` at depth 0.
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
      if (frozen !== undefined) return frozen
    }
    return undefined
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
