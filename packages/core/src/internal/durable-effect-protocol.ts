import type { DurableEffectRecord, DurableEffectState } from "../durable-execution.ts"

export interface DurableEffectTransitionInput {
  readonly effectId: string
  readonly version: number
  readonly from: DurableEffectState
  readonly to: DurableEffectState
  readonly updatedAt: number
  readonly errorCode?: string
}

export interface DurableEffectProtocol {
  transition(
    current: DurableEffectRecord | undefined,
    input: DurableEffectTransitionInput,
  ): DurableEffectRecord | undefined
}

function transitionEffect(
  current: DurableEffectRecord | undefined,
  input: DurableEffectTransitionInput,
): DurableEffectRecord | undefined {
  if (current === undefined || current.version !== input.version || current.state !== input.from) {
    return undefined
  }
  return Object.freeze({
    ...current,
    state: input.to,
    updatedAt: input.updatedAt,
    version: current.version + 1,
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
  })
}

export const durableEffectProtocol: DurableEffectProtocol = Object.freeze({
  transition: transitionEffect,
})
