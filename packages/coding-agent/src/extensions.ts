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

function staticDeclaredCapabilities(source: string): readonly string[] | undefined {
  // Strip line and block comments so commented examples never pass or fail validation.
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  const match = /\bexport\s+(?:const|let|var)\s+capabilities(?:\s*:[^=]+)?\s*=\s*\[([^\]]*)\]/.exec(
    stripped,
  )
  if (match === null) return undefined
  const body = match[1] ?? ""
  const entries = body
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  const capabilities: string[] = []
  for (const entry of entries) {
    const literal = /^(?:"([^"\\]+)"|'([^'\\]+)'|`([^`$\\]+)`)$/.exec(entry)
    if (literal === null) return undefined
    const value = literal[1] ?? literal[2] ?? literal[3]
    if (value !== undefined) capabilities.push(value)
  }
  return capabilities
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
