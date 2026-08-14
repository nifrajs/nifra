import type { SagaRecord, SagaState, SagaStepRecord, SagaStore } from "../durable-execution.ts"

export type DurableSagaTransitionInput = Parameters<SagaStore["compareAndSet"]>[0]

export interface DurableSagaProtocol {
  transition(
    current: SagaRecord | undefined,
    input: DurableSagaTransitionInput,
  ): SagaRecord | undefined
  withStep(
    record: SagaRecord,
    index: number,
    step: SagaStepRecord,
    state: SagaState,
    updatedAt: number,
  ): Omit<SagaRecord, "version">
}

function transitionSaga(
  current: SagaRecord | undefined,
  input: DurableSagaTransitionInput,
): SagaRecord | undefined {
  if (
    input.record.version !== input.version + 1 ||
    (current !== undefined &&
      (current.sagaId !== input.sagaId || current.version !== input.version))
  ) {
    return undefined
  }
  return Object.freeze({ ...input.record })
}

function withSagaStep(
  record: SagaRecord,
  index: number,
  step: SagaStepRecord,
  state: SagaState,
  updatedAt: number,
): Omit<SagaRecord, "version"> {
  return {
    ...record,
    state,
    steps: Object.freeze(
      record.steps.map((candidate, candidateIndex) =>
        candidateIndex === index ? Object.freeze(step) : candidate,
      ),
    ),
    updatedAt,
  }
}

export const durableSagaProtocol: DurableSagaProtocol = Object.freeze({
  transition: transitionSaga,
  withStep: withSagaStep,
})
