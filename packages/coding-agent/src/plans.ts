import {
  type WorkflowEvent,
  type WorkflowResult,
  WorkflowRunner,
  type WorkflowStep,
} from "./workflows.ts"

export interface PlanPhase {
  readonly id: string
  readonly title: string
  readonly step: WorkflowStep
}

export interface AgentPlan {
  readonly id: string
  readonly goal: string
  readonly phases: readonly PlanPhase[]
  readonly maxSteps?: number
  readonly maxDepth?: number
}

export interface PlanEvent {
  readonly type:
    | "plan.started"
    | "plan.phase.started"
    | "plan.phase.completed"
    | "plan.completed"
    | "plan.failed"
  readonly planId: string
  readonly phaseId?: string
  readonly message?: string
}

export interface PlanRunnerOptions {
  readonly signal?: AbortSignal
  readonly onEvent?: (event: PlanEvent | WorkflowEvent) => void | PromiseLike<void>
}

export interface PlanResult extends WorkflowResult {
  readonly planId: string
  readonly goal: string
}

/** First-party plan mode built on the bounded workflow primitives; no model or UI dependency. */
export class PlanRunner {
  private readonly options: PlanRunnerOptions

  constructor(options: PlanRunnerOptions = {}) {
    this.options = options
  }

  async run(plan: AgentPlan): Promise<PlanResult> {
    validatePlan(plan)
    await this.emit({ type: "plan.started", planId: plan.id, message: plan.goal })
    const workflow = new WorkflowRunner({
      ...(this.options.signal === undefined ? {} : { signal: this.options.signal }),
      ...(plan.maxSteps === undefined ? {} : { maxSteps: plan.maxSteps }),
      ...(plan.maxDepth === undefined ? {} : { maxDepth: plan.maxDepth }),
      onEvent: async (event) => this.options.onEvent?.(event),
    })
    const step: WorkflowStep = {
      type: "sequence",
      steps: plan.phases.map((phase) => ({
        type: "task" as const,
        id: phase.id,
        run: async (context) => {
          await this.emit({
            type: "plan.phase.started",
            planId: plan.id,
            phaseId: phase.id,
            message: phase.title,
          })
          const output = await context.run(phase.step)
          await this.emit({ type: "plan.phase.completed", planId: plan.id, phaseId: phase.id })
          return output
        },
      })),
    }
    const result = await workflow.run(step)
    await this.emit({
      type: result.ok ? "plan.completed" : "plan.failed",
      planId: plan.id,
      ...(result.error === undefined ? {} : { message: result.error }),
    })
    return { ...result, planId: plan.id, goal: plan.goal }
  }

  private async emit(event: PlanEvent): Promise<void> {
    await this.options.onEvent?.(event)
  }
}

function validatePlan(plan: AgentPlan): void {
  if (!/^[a-z][a-z0-9._:-]{0,63}$/.test(plan.id)) throw new TypeError("plan: id is invalid")
  if (!plan.goal || plan.goal.length > 4_096) throw new TypeError("plan: goal is empty or too long")
  if (plan.phases.length === 0 || plan.phases.length > 128)
    throw new RangeError("plan: phases must be between 1 and 128")
  const ids = new Set<string>()
  for (const phase of plan.phases) {
    if (!/^[a-z][a-z0-9._:-]{0,63}$/.test(phase.id) || !phase.title || phase.title.length > 256)
      throw new TypeError(`plan: invalid phase ${phase.id}`)
    if (ids.has(phase.id)) throw new TypeError(`plan: duplicate phase ${phase.id}`)
    ids.add(phase.id)
  }
}
