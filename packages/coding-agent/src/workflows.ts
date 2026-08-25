import { publicErrorDetails } from "./errors.ts"

export interface WorkflowContext {
  readonly signal: AbortSignal
  readonly values: ReadonlyMap<string, unknown>
  set(name: string, value: unknown): void
  run(step: WorkflowStep): Promise<unknown>
}

export type WorkflowStep =
  | {
      readonly type: "task"
      readonly id: string
      readonly run: (context: WorkflowContext) => unknown | PromiseLike<unknown>
    }
  | { readonly type: "sequence"; readonly steps: readonly WorkflowStep[] }
  | {
      readonly type: "parallel"
      readonly steps: readonly WorkflowStep[]
      readonly maxConcurrency?: number
    }
  | {
      readonly type: "verify"
      readonly id: string
      readonly run: (
        context: WorkflowContext,
      ) => unknown | PromiseLike<boolean | { readonly ok: boolean; readonly report?: unknown }>
    }
  | {
      readonly type: "approve"
      readonly id: string
      readonly reason: string
      readonly run: (context: WorkflowContext) => unknown | PromiseLike<boolean>
    }
  | {
      readonly type: "retry"
      readonly step: WorkflowStep
      readonly attempts?: number
      readonly backoffMs?: number
    }
  | {
      readonly type: "branch"
      readonly id: string
      readonly when: (context: WorkflowContext) => boolean | PromiseLike<boolean>
      readonly then: WorkflowStep
      readonly otherwise?: WorkflowStep
    }
  | {
      readonly type: "checkpoint"
      readonly id: string
      readonly run: (context: WorkflowContext) => unknown | PromiseLike<unknown>
    }
  | {
      readonly type: "handoff"
      readonly id: string
      readonly run: (context: WorkflowContext) => unknown | PromiseLike<unknown>
    }

export interface WorkflowRunnerOptions {
  readonly signal?: AbortSignal
  readonly maxSteps?: number
  readonly maxDepth?: number
  readonly onEvent?: (event: WorkflowEvent) => void | PromiseLike<void>
  readonly exposeErrorStacks?: boolean
}

export type WorkflowEvent =
  | { readonly type: "step.started"; readonly id: string }
  | { readonly type: "step.completed"; readonly id: string; readonly output?: unknown }
  | {
      readonly type: "step.failed"
      readonly id: string
      readonly error: string
      readonly stack?: string
    }
  | { readonly type: "approval.required"; readonly id: string; readonly reason: string }
  | { readonly type: "checkpoint.created"; readonly id: string }

export interface WorkflowResult {
  readonly ok: boolean
  readonly values: ReadonlyMap<string, unknown>
  readonly completed: readonly string[]
  readonly error?: string
  readonly stack?: string
}

/** Bounded orchestration primitives. The kernel knows no provider, UI, or framework package. */
export class WorkflowRunner {
  private readonly options: Required<Pick<WorkflowRunnerOptions, "maxSteps" | "maxDepth">> &
    WorkflowRunnerOptions
  private readonly values = new Map<string, unknown>()
  private readonly completed: string[] = []
  private steps = 0

  constructor(options: WorkflowRunnerOptions = {}) {
    this.options = {
      ...options,
      maxSteps: options.maxSteps ?? 128,
      maxDepth: options.maxDepth ?? 8,
    }
    if (!Number.isSafeInteger(this.options.maxSteps) || this.options.maxSteps < 1)
      throw new RangeError("workflow: maxSteps must be positive")
    if (!Number.isSafeInteger(this.options.maxDepth) || this.options.maxDepth < 1)
      throw new RangeError("workflow: maxDepth must be positive")
  }

  async run(step: WorkflowStep): Promise<WorkflowResult> {
    try {
      await this.execute(step, 0)
      return {
        ok: true,
        values: new Map(this.values),
        completed: Object.freeze([...this.completed]),
      }
    } catch (error) {
      const details = publicErrorDetails(
        error,
        "workflow failed",
        this.options.exposeErrorStacks === true,
      )
      return {
        ok: false,
        values: new Map(this.values),
        completed: Object.freeze([...this.completed]),
        error: details.message,
        ...(details.stack === undefined ? {} : { stack: details.stack }),
      }
    }
  }

  private context(): WorkflowContext {
    return {
      signal: this.options.signal ?? new AbortController().signal,
      values: this.values,
      set: (name, value) => this.values.set(name, value),
      run: (step) => this.execute(step, 1),
    }
  }

  private async execute(step: WorkflowStep, depth: number): Promise<unknown> {
    if (depth > this.options.maxDepth) throw new Error("workflow max depth exceeded")
    if (++this.steps > this.options.maxSteps) throw new Error("workflow max steps exceeded")
    if (this.options.signal?.aborted) throw new Error("workflow cancelled")
    switch (step.type) {
      case "task":
        return this.single(step.id, () => step.run(this.context()))
      case "verify": {
        const result = await this.single(step.id, () => step.run(this.context()))
        const ok = typeof result === "boolean" ? result : isVerificationResult(result) && result.ok
        if (!ok) throw new Error(`verification failed: ${step.id}`)
        return result
      }
      case "approve": {
        await this.emit({ type: "approval.required", id: step.id, reason: step.reason })
        const approved = await this.single(step.id, () => step.run(this.context()))
        if (approved !== true) throw new Error(`approval denied: ${step.id}`)
        return approved
      }
      case "checkpoint": {
        const result = await this.single(step.id, () => step.run(this.context()))
        await this.emit({ type: "checkpoint.created", id: step.id })
        return result
      }
      case "handoff":
        return this.single(step.id, () => step.run(this.context()))
      case "sequence": {
        const results: unknown[] = []
        for (const child of step.steps) results.push(await this.execute(child, depth + 1))
        return results
      }
      case "parallel":
        return this.parallel(step.steps, step.maxConcurrency ?? step.steps.length, depth)
      case "retry": {
        const attempts = step.attempts ?? 3
        if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 16)
          throw new RangeError("workflow: attempts must be between 1 and 16")
        let last: unknown
        for (let attempt = 0; attempt < attempts; attempt++) {
          try {
            return await this.execute(step.step, depth + 1)
          } catch (error) {
            last = error
            if (attempt + 1 < attempts && (step.backoffMs ?? 0) > 0)
              await delay(Math.min(step.backoffMs! * (attempt + 1), 10_000), this.options.signal)
          }
        }
        throw last instanceof Error ? last : new Error(String(last))
      }
      case "branch": {
        const selected = await this.single(step.id, () => step.when(this.context()))
        return selected === true
          ? this.execute(step.then, depth + 1)
          : step.otherwise === undefined
            ? undefined
            : this.execute(step.otherwise, depth + 1)
      }
    }
  }

  private async single(id: string, run: () => unknown | PromiseLike<unknown>): Promise<unknown> {
    await this.emit({ type: "step.started", id })
    try {
      const output = await run()
      this.completed.push(id)
      await this.emit({ type: "step.completed", id, ...(output === undefined ? {} : { output }) })
      return output
    } catch (error) {
      const details = publicErrorDetails(
        error,
        "workflow step failed",
        this.options.exposeErrorStacks === true,
      )
      await this.emit({
        type: "step.failed",
        id,
        error: details.message,
        ...(details.stack === undefined ? {} : { stack: details.stack }),
      })
      throw error
    }
  }

  private async parallel(
    steps: readonly WorkflowStep[],
    maxConcurrency: number,
    depth: number,
  ): Promise<readonly unknown[]> {
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1)
      throw new RangeError("workflow: maxConcurrency must be positive")
    const outputs: unknown[] = new Array(steps.length)
    let next = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++
        if (index >= steps.length) return
        outputs[index] = await this.execute(steps[index]!, depth + 1)
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(maxConcurrency, steps.length) }, () => worker()),
    )
    return outputs
  }

  private async emit(event: WorkflowEvent): Promise<void> {
    await this.options.onEvent?.(event)
  }
}

async function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (signal === undefined) return
    if (signal.aborted) {
      clearTimeout(timer)
      reject(new Error("workflow cancelled"))
      return
    }
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(new Error("workflow cancelled"))
      },
      { once: true },
    )
  })
}

function isVerificationResult(
  value: unknown,
): value is { readonly ok: boolean; readonly report?: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { readonly ok?: unknown }).ok === "boolean"
  )
}
