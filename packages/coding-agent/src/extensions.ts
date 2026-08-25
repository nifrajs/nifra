import { existsSync, realpathSync } from "node:fs"
import { join, relative, resolve } from "node:path"
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

/**
 * Transactional TypeScript extension loader for the Nifra-native backend.
 *
 * This loader only activates explicitly supplied files. It never scans a project implicitly and it
 * leaves the previous extension graph intact when a staged reload fails.
 */
export class ExtensionHost {
  private readonly options: ExtensionHostOptions
  private active: readonly CodingAgentExtension[] = []
  private commands = new Map<string, ExtensionCommand>()
  private tools = new Map<string, ExtensionTool>()
  private workflows = new Map<string, ExtensionWorkflow>()
  private subagents = new Map<string, ExtensionSubagent>()
  private providers = new Map<string, ExtensionProvider>()
  private handlers = new Map<string, ExtensionEventHandler[]>()
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
    return Object.freeze([...this.commands.keys()].sort())
  }

  get availableTools(): readonly ExtensionTool[] {
    return Object.freeze([...this.tools.values()])
  }

  get availableWorkflows(): readonly string[] {
    return Object.freeze([...this.workflows.keys()].sort())
  }

  get availableSubagents(): readonly ExtensionSubagent[] {
    return Object.freeze([...this.subagents.values()])
  }

  get availableProviders(): readonly ExtensionProvider[] {
    return Object.freeze([...this.providers.values()])
  }

  async reload(): Promise<ExtensionReloadResult> {
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
    const next: CodingAgentExtension[] = []
    const nextCommands = new Map<string, ExtensionCommand>()
    const nextTools = new Map<string, ExtensionTool>()
    const nextWorkflows = new Map<string, ExtensionWorkflow>()
    const nextSubagents = new Map<string, ExtensionSubagent>()
    const nextProviders = new Map<string, ExtensionProvider>()
    const nextHandlers = new Map<string, ExtensionEventHandler[]>()
    try {
      if (pathError !== undefined) throw new Error(pathError)
      for (const path of paths) {
        await this.options.validate?.(path)
        const loaded = await this.loadOne(
          path,
          nextCommands,
          nextTools,
          nextWorkflows,
          nextSubagents,
          nextProviders,
          nextHandlers,
        )
        next.push(loaded)
      }
      const previous = this.active
      this.active = Object.freeze(next)
      this.commands = nextCommands
      this.tools = nextTools
      this.workflows = nextWorkflows
      this.subagents = nextSubagents
      this.providers = nextProviders
      this.handlers = nextHandlers
      this.revision = `${Date.now().toString(36)}-${next.length}`
      for (const extension of previous) {
        try {
          await extension.dispose?.()
        } catch (error) {
          this.options.onError?.({ path: extension.path, error })
        }
      }
      return {
        revision: this.revision,
        loaded: Object.freeze(next.map((extension) => extension.id)),
        disabled: [],
        rolledBack: false,
      }
    } catch (error) {
      for (const extension of next.reverse()) {
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
  }

  async close(): Promise<void> {
    const active = this.active
    this.active = []
    this.commands = new Map()
    this.tools = new Map()
    this.workflows = new Map()
    this.subagents = new Map()
    this.providers = new Map()
    this.handlers = new Map()
    for (const extension of active) await extension.dispose?.()
  }

  command(name: string): ExtensionCommand | undefined {
    return this.commands.get(name)
  }

  tool(name: string): ExtensionTool | undefined {
    return this.tools.get(name)
  }

  workflow(name: string): ExtensionWorkflow | undefined {
    return this.workflows.get(name)
  }

  subagent(name: string): ExtensionSubagent | undefined {
    return this.subagents.get(name)
  }

  provider(name: string): ExtensionProvider | undefined {
    return this.providers.get(name)
  }

  async runWorkflow(name: string, options: WorkflowRunOptions = {}): Promise<WorkflowResult> {
    const workflow = this.workflows.get(name)
    if (workflow === undefined) throw new Error(`unknown extension workflow: ${name}`)
    const step = await workflow(this.context())
    return new WorkflowRunner(options).run(step)
  }

  async emit(event: string, payload: unknown): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) await handler(payload, this.context())
  }

  private async loadOne(
    path: string,
    commands: Map<string, ExtensionCommand>,
    tools: Map<string, ExtensionTool>,
    workflows: Map<string, ExtensionWorkflow>,
    subagents: Map<string, ExtensionSubagent>,
    providers: Map<string, ExtensionProvider>,
    handlers: Map<string, ExtensionEventHandler[]>,
  ): Promise<CodingAgentExtension> {
    const module = (await import(`${path}?revision=${Date.now()}-${Math.random()}`)) as {
      default?: ExtensionFactory
      id?: string
      capabilities?: readonly string[]
    }
    if (typeof module.default !== "function")
      throw new Error(`extension ${path} has no default factory`)
    const capabilities = Object.freeze([...(module.capabilities ?? [])])
    const trusted = new Set(this.options.trustedCapabilities ?? [])
    const denied = capabilities.find((capability) => !trusted.has(capability))
    if (denied !== undefined)
      throw new Error(`extension ${path} requires untrusted capability: ${denied}`)
    const context = this.context(commands, tools, workflows, subagents, providers, handlers)
    const result = await module.default(context)
    return Object.freeze({
      id: module.id ?? path,
      path,
      capabilities,
      ...(result &&
      typeof result === "object" &&
      "dispose" in result &&
      typeof result.dispose === "function"
        ? { dispose: result.dispose }
        : {}),
    })
  }

  private context(
    commands = this.commands,
    tools = this.tools,
    workflows = this.workflows,
    subagents = this.subagents,
    providers = this.providers,
    handlers = this.handlers,
  ): ExtensionContext {
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

function isWithin(root: string, candidate: string): boolean {
  const canonical = (path: string): string => {
    try {
      return realpathSync(path)
    } catch {
      return resolve(path)
    }
  }
  const relativePath = relative(canonical(root), canonical(candidate))
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.includes("/.."))
}
