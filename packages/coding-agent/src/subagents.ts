import { relative, resolve } from "node:path"

export interface SubagentSpec {
  readonly id: string
  readonly role: string
  readonly prompt: string
  readonly capabilities?: readonly string[]
  readonly maxDepth?: number
  readonly timeoutMs?: number
  readonly cwd?: string
}

export interface SubagentResult {
  readonly id: string
  readonly role: string
  readonly ok: boolean
  readonly output?: unknown
  readonly error?: string
}

export interface SubagentExecutor {
  run(input: {
    readonly spec: SubagentSpec
    readonly signal: AbortSignal
    readonly cwd?: string
  }): unknown | PromiseLike<unknown>
}

export interface SubagentWorkspaceLease {
  readonly cwd: string
  readonly cleanup?: () => void | PromiseLike<void>
}

/** Workspace policy seam for callers that need project boundaries or isolated worktrees. */
export interface SubagentWorkspacePolicy {
  readonly root: string
  readonly allowedRoots?: readonly string[]
  readonly isolatedWorktree?: (
    spec: SubagentSpec,
    signal: AbortSignal,
  ) => SubagentWorkspaceLease | PromiseLike<SubagentWorkspaceLease>
}

export interface SubagentRunnerOptions {
  readonly maxChildren?: number
  readonly maxDepth?: number
  readonly depth?: number
  readonly signal?: AbortSignal
  readonly allowedCapabilities?: readonly string[]
  readonly workspace?: SubagentWorkspacePolicy
}

/** Explicitly bounded child execution. Recursive fan-out is impossible without a caller budget. */
export class BoundedSubagentRunner {
  private readonly executor: SubagentExecutor
  private readonly options: Required<
    Pick<SubagentRunnerOptions, "maxChildren" | "maxDepth" | "depth">
  > &
    SubagentRunnerOptions
  private children = 0

  constructor(executor: SubagentExecutor, options: SubagentRunnerOptions = {}) {
    this.executor = executor
    this.options = {
      ...options,
      maxChildren: options.maxChildren ?? 4,
      maxDepth: options.maxDepth ?? 2,
      depth: options.depth ?? 0,
    }
    if (this.options.maxChildren < 1 || this.options.maxDepth < 0 || this.options.depth < 0)
      throw new RangeError(
        "subagents: limits must be non-negative and maxChildren must be positive",
      )
  }

  async run(spec: SubagentSpec): Promise<SubagentResult> {
    if (!/^[a-z][a-z0-9._:-]{0,63}$/.test(spec.id))
      return { id: spec.id, role: spec.role, ok: false, error: "invalid subagent id" }
    if (++this.children > this.options.maxChildren)
      return { id: spec.id, role: spec.role, ok: false, error: "subagent child limit exceeded" }
    if (this.options.depth > this.options.maxDepth)
      return { id: spec.id, role: spec.role, ok: false, error: "subagent depth limit exceeded" }
    if (spec.prompt.length === 0 || spec.prompt.length > 16_384)
      return {
        id: spec.id,
        role: spec.role,
        ok: false,
        error: "subagent prompt is empty or too long",
      }
    if (
      spec.timeoutMs !== undefined &&
      (!Number.isSafeInteger(spec.timeoutMs) ||
        spec.timeoutMs < 1 ||
        spec.timeoutMs > 24 * 60 * 60_000)
    )
      return { id: spec.id, role: spec.role, ok: false, error: "subagent timeout is invalid" }
    const allowed =
      this.options.allowedCapabilities === undefined
        ? undefined
        : new Set(this.options.allowedCapabilities)
    const denied = spec.capabilities?.find(
      (capability) => allowed !== undefined && !allowed.has(capability),
    )
    if (denied !== undefined)
      return {
        id: spec.id,
        role: spec.role,
        ok: false,
        error: `subagent capability denied: ${denied}`,
      }
    const controller = new AbortController()
    const onAbort = (): void => controller.abort(this.options.signal?.reason)
    this.options.signal?.addEventListener("abort", onAbort, { once: true })
    const timeout =
      spec.timeoutMs === undefined
        ? undefined
        : setTimeout(() => controller.abort("timeout"), spec.timeoutMs)
    let workspace: SubagentWorkspaceLease | undefined
    try {
      const requestedCwd =
        spec.cwd === undefined
          ? this.options.workspace?.root
          : this.options.workspace === undefined
            ? resolve(spec.cwd)
            : resolve(this.options.workspace.root, spec.cwd)
      if (requestedCwd !== undefined && this.options.workspace !== undefined) {
        if (!within(this.options.workspace.root, requestedCwd))
          return {
            id: spec.id,
            role: spec.role,
            ok: false,
            error: "subagent workspace escapes policy root",
          }
        const allowedRoots = this.options.workspace.allowedRoots ?? [this.options.workspace.root]
        if (!allowedRoots.some((root) => within(root, requestedCwd)))
          return {
            id: spec.id,
            role: spec.role,
            ok: false,
            error: "subagent workspace is not in an allowed root",
          }
      }
      if (this.options.workspace?.isolatedWorktree !== undefined) {
        workspace = await this.options.workspace.isolatedWorktree(spec, controller.signal)
      } else if (requestedCwd !== undefined) {
        workspace = { cwd: requestedCwd }
      }
      if (workspace !== undefined && this.options.workspace !== undefined) {
        const allowedRoots = this.options.workspace.allowedRoots ?? [this.options.workspace.root]
        if (
          !within(this.options.workspace.root, workspace.cwd) ||
          !allowedRoots.some((root) => within(root, workspace!.cwd))
        )
          return {
            id: spec.id,
            role: spec.role,
            ok: false,
            error: "isolated worktree escapes workspace policy",
          }
      }
      const output = await this.executor.run({
        spec,
        signal: controller.signal,
        ...(workspace === undefined ? {} : { cwd: workspace.cwd }),
      })
      return { id: spec.id, role: spec.role, ok: true, output }
    } catch (error) {
      return {
        id: spec.id,
        role: spec.role,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      await workspace?.cleanup?.()
      if (timeout !== undefined) clearTimeout(timeout)
      this.options.signal?.removeEventListener("abort", onAbort)
    }
  }

  async runMany(
    specs: readonly SubagentSpec[],
    maxConcurrency = this.options.maxChildren,
  ): Promise<readonly SubagentResult[]> {
    if (specs.length > this.options.maxChildren) throw new Error("subagent child limit exceeded")
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1)
      throw new RangeError("subagents: maxConcurrency must be positive")
    const results: SubagentResult[] = new Array(specs.length)
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++
        if (index >= specs.length) return
        results[index] = await this.run(specs[index]!)
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(maxConcurrency, specs.length) }, () => worker()),
    )
    return results
  }
}

function within(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate))
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith("../"))
}
