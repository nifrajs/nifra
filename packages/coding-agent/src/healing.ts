export interface RepairProposal<State = unknown> {
  readonly id: string
  readonly reason: string
  readonly capabilities?: readonly string[]
  readonly stage: () => State | PromiseLike<State>
  readonly verify: (state: State) => boolean | PromiseLike<boolean>
  /** Commit the verified staged state. If it fails, rollback still runs. */
  readonly activate?: (state: State) => void | PromiseLike<void>
  /** Optional post-activation health check. A false result triggers rollback. */
  readonly monitor?: (state: State) => boolean | PromiseLike<boolean>
  readonly rollback: (state?: State) => void | PromiseLike<void>
}

export interface HealingOptions {
  readonly trustedCapabilities?: readonly string[]
  readonly maxAttempts?: number
  readonly onEvent?: (event: HealingEvent) => void | PromiseLike<void>
}

export type HealingEvent =
  | { readonly type: "repair.staged"; readonly id: string; readonly attempt: number }
  | { readonly type: "repair.verified"; readonly id: string; readonly attempt: number }
  | { readonly type: "repair.activated"; readonly id: string; readonly attempt: number }
  | { readonly type: "repair.unhealthy"; readonly id: string; readonly attempt: number }
  | {
      readonly type: "repair.rolled_back"
      readonly id: string
      readonly attempt: number
      readonly error: string
    }
  | { readonly type: "repair.denied"; readonly id: string; readonly capability: string }

export interface HealingResult {
  readonly ok: boolean
  readonly attempts: number
  readonly error?: string
}

/** Staged repair loop for extensions, tools, and workflows. It never activates an unverified change. */
export class SelfHealingController {
  private readonly options: Required<Pick<HealingOptions, "maxAttempts">> & HealingOptions

  constructor(options: HealingOptions = {}) {
    this.options = { ...options, maxAttempts: options.maxAttempts ?? 2 }
    if (
      !Number.isSafeInteger(this.options.maxAttempts) ||
      this.options.maxAttempts < 1 ||
      this.options.maxAttempts > 8
    )
      throw new RangeError("healing: maxAttempts must be between 1 and 8")
  }

  async repair<State>(proposal: RepairProposal<State>): Promise<HealingResult> {
    if (!/^[a-z][a-z0-9._:-]{0,63}$/.test(proposal.id))
      return { ok: false, attempts: 0, error: "invalid repair id" }
    const trusted = new Set(this.options.trustedCapabilities ?? [])
    const denied = (proposal.capabilities ?? []).find((capability) => !trusted.has(capability))
    if (denied !== undefined) {
      await this.emit({ type: "repair.denied", id: proposal.id, capability: denied })
      return { ok: false, attempts: 0, error: `untrusted capability: ${denied}` }
    }
    let lastError = "repair failed"
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
      let state: State | undefined
      try {
        state = await proposal.stage()
        await this.emit({ type: "repair.staged", id: proposal.id, attempt })
        if (!(await proposal.verify(state))) throw new Error("repair verification failed")
        await this.emit({ type: "repair.verified", id: proposal.id, attempt })
        await proposal.activate?.(state)
        await this.emit({ type: "repair.activated", id: proposal.id, attempt })
        if (proposal.monitor !== undefined && !(await proposal.monitor(state))) {
          await this.emit({ type: "repair.unhealthy", id: proposal.id, attempt })
          throw new Error("repair monitor reported unhealthy")
        }
        return { ok: true, attempts: attempt }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        try {
          await proposal.rollback(state)
        } catch (rollbackError) {
          lastError = `${lastError}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        }
        await this.emit({ type: "repair.rolled_back", id: proposal.id, attempt, error: lastError })
      }
    }
    return { ok: false, attempts: this.options.maxAttempts, error: lastError }
  }

  private async emit(event: HealingEvent): Promise<void> {
    await this.options.onEvent?.(event)
  }
}
