/**
 * Registration-compiled general route program.
 *
 * This is deliberately a data-and-control-flow compiler, not source generation: user functions and
 * schemas remain opaque references and no request value is ever converted into executable code. The
 * program is frozen at registration so the request path walks one immutable stage sequence instead
 * of rediscovering which lifecycle features are present.
 */

import type { StandardSchemaV1 } from "../schema/standard.ts"
import type { Registry } from "../server/registry.ts"
import {
  CONTEXT_SET,
  EMPTY_RESPONSE_CONTROLS,
  isResponseResult,
  type ResponseResult,
} from "../server/runtime-core.ts"
import type { CtxSet, MaybePromise, RawContext, RequestSource, Server } from "../server/server.ts"
import type {
  InternalHandler,
  RawAfterHandle,
  RawBeforeHandle,
  RawDerive,
  RawErrorHandler,
  RouteEntry,
} from "./route-execution.ts"

export type ProgramValidationKind = "headers" | "params" | "body" | "query"

export type RouteProgramStage =
  | { readonly kind: ProgramValidationKind; readonly schema: StandardSchemaV1 }
  | { readonly kind: "derive"; readonly run: RawDerive }
  | { readonly kind: "before"; readonly run: RawBeforeHandle }
  | { readonly kind: "handler"; readonly run: InternalHandler }
  | { readonly kind: "after"; readonly run: RawAfterHandle }

/** The complete registration-time lifecycle, in semantic execution order. */
export interface RouteProgram {
  readonly stages: readonly RouteProgramStage[]
  readonly validationStages: readonly Extract<RouteProgramStage, { kind: ProgramValidationKind }>[]
  readonly derives: readonly RawDerive[]
  readonly beforeHandle: readonly RawBeforeHandle[]
  readonly afterHandle: readonly RawAfterHandle[]
  readonly onError: readonly RawErrorHandler[]
  readonly handler: InternalHandler
  readonly decorations: Record<PropertyKey, unknown>
  readonly hasDecorations: boolean
  readonly bodySchema: StandardSchemaV1 | undefined
  readonly bodyLimit: RouteEntry["bodyLimit"]
  readonly responseContract: RouteEntry["responseContract"]
}

export interface RouteProgramInput {
  readonly schema: RouteEntry["schema"]
  readonly handler: InternalHandler
  readonly derives: readonly RawDerive[]
  readonly beforeHandle: readonly RawBeforeHandle[]
  readonly afterHandle: readonly RawAfterHandle[]
  readonly onError: readonly RawErrorHandler[]
  readonly decorations: Record<PropertyKey, unknown>
  readonly hasDecorations: boolean
  readonly bodySchema: StandardSchemaV1 | undefined
  readonly bodyLimit: RouteEntry["bodyLimit"]
  readonly responseContract: RouteEntry["responseContract"]
}

/** Build the immutable stage sequence once, while the server is still configurable. */
export function compileRouteProgram(input: RouteProgramInput): RouteProgram {
  const stages: RouteProgramStage[] = []
  const validationStages: Extract<RouteProgramStage, { kind: ProgramValidationKind }>[] = []
  const schema = input.schema
  if (schema?.headers !== undefined) {
    const stage = { kind: "headers", schema: schema.headers } as const
    stages.push(stage)
    validationStages.push(stage)
  }
  if (schema?.params !== undefined) {
    const stage = { kind: "params", schema: schema.params } as const
    stages.push(stage)
    validationStages.push(stage)
  }
  if (schema?.body !== undefined) {
    const stage = { kind: "body", schema: schema.body } as const
    stages.push(stage)
    validationStages.push(stage)
  }
  if (schema?.query !== undefined) {
    const stage = { kind: "query", schema: schema.query } as const
    stages.push(stage)
    validationStages.push(stage)
  }
  for (const derive of input.derives) stages.push({ kind: "derive", run: derive })
  for (const before of input.beforeHandle) stages.push({ kind: "before", run: before })
  stages.push({ kind: "handler", run: input.handler })
  for (const after of input.afterHandle) stages.push({ kind: "after", run: after })

  return Object.freeze({
    stages: Object.freeze(stages),
    validationStages: Object.freeze(validationStages),
    derives: Object.freeze([...input.derives]),
    beforeHandle: Object.freeze([...input.beforeHandle]),
    afterHandle: Object.freeze([...input.afterHandle]),
    onError: Object.freeze([...input.onError]),
    handler: input.handler,
    decorations: Object.freeze({ ...input.decorations }),
    hasDecorations: input.hasDecorations,
    bodySchema: input.bodySchema,
    bodyLimit: input.bodyLimit,
    responseContract: input.responseContract,
  })
}

interface RouteProgramRuntime {
  validateProgramStage(
    entry: RouteEntry,
    stage: Extract<RouteProgramStage, { kind: ProgramValidationKind }>,
    source: RequestSource,
    ctx: RawContext,
  ): MaybePromise<Response | ResponseResult | undefined>
  readProgramBody(
    entry: RouteEntry,
    source: RequestSource,
    ctx: RawContext,
  ): Promise<Response | ResponseResult | undefined>
  handleProgramError<T>(
    entry: RouteEntry,
    error: unknown,
    ctx: RawContext,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response | ResponseResult) => T,
  ): MaybePromise<T>
  finishProgramResult<T>(
    entry: RouteEntry,
    ctx: RawContext,
    result: unknown,
    finalize: (result: unknown, set: CtxSet) => T,
    wrapResponse: (response: Response | ResponseResult) => T,
  ): MaybePromise<T>
}

function responseSet(ctx: RawContext): CtxSet {
  return ctx[CONTEXT_SET]() ?? EMPTY_RESPONSE_CONTROLS
}

function isEarly(value: unknown): value is Response | ResponseResult {
  return value instanceof Response || isResponseResult(value)
}

type ProgramResult<T> = MaybePromise<T>

type PendingPhase =
  | { readonly kind: "validation"; readonly next: number }
  | { readonly kind: "derive"; readonly next: number }
  | { readonly kind: "before"; readonly next: number }
  | { readonly kind: "handler" }
  | { readonly kind: "after"; readonly next: number }

/** Execute the general program. The first synchronous stage sequence stays synchronous. */
export function executeRouteProgram<T, R extends Registry, Ctx>(
  runtime: Server<R, Ctx>,
  entry: RouteEntry,
  program: RouteProgram,
  source: RequestSource,
  ctx: RawContext,
  finalize: (result: unknown, set: CtxSet) => T,
  wrapResponse: (response: Response | ResponseResult) => T,
): ProgramResult<T> {
  const host = runtime as unknown as RouteProgramRuntime
  try {
    if (program.hasDecorations) Object.assign(ctx, program.decorations)
    return runSync(host, entry, program, source, ctx, finalize, wrapResponse, 0, undefined)
  } catch (error) {
    return host.handleProgramError(entry, error, ctx, finalize, wrapResponse)
  }
}

function runSync<T>(
  host: RouteProgramRuntime,
  entry: RouteEntry,
  program: RouteProgram,
  source: RequestSource,
  ctx: RawContext,
  finalize: (result: unknown, set: CtxSet) => T,
  wrapResponse: (response: Response | ResponseResult) => T,
  validationIndex: number,
  initial: unknown,
): ProgramResult<T> {
  const validations = program.validationStages
  for (let i = validationIndex; i < validations.length; i++) {
    const stage = validations[i]!
    const outcome =
      stage.kind === "body"
        ? host.readProgramBody(entry, source, ctx)
        : host.validateProgramStage(entry, stage, source, ctx)
    if (outcome instanceof Promise) {
      return continueProgram(
        host,
        entry,
        program,
        source,
        ctx,
        finalize,
        wrapResponse,
        { kind: "validation", next: i + 1 },
        outcome,
        initial,
      )
    }
    if (outcome !== undefined) return wrapResponse(outcome)
  }
  return runHooksSync(host, entry, program, source, ctx, finalize, wrapResponse, 0, 0, 0, initial)
}

function runHooksSync<T>(
  host: RouteProgramRuntime,
  entry: RouteEntry,
  program: RouteProgram,
  source: RequestSource,
  ctx: RawContext,
  finalize: (result: unknown, set: CtxSet) => T,
  wrapResponse: (response: Response | ResponseResult) => T,
  deriveIndex: number,
  beforeIndex: number,
  afterIndex: number,
  initial: unknown,
): ProgramResult<T> {
  for (let i = deriveIndex; i < program.derives.length; i++) {
    const outcome = program.derives[i]!(ctx)
    if (outcome instanceof Promise) {
      return continueProgram(
        host,
        entry,
        program,
        source,
        ctx,
        finalize,
        wrapResponse,
        { kind: "derive", next: i + 1 },
        outcome,
        initial,
      )
    }
    if (isEarly(outcome)) return finalize(outcome, responseSet(ctx))
    Object.assign(ctx, outcome)
  }
  for (let i = beforeIndex; i < program.beforeHandle.length; i++) {
    const outcome = program.beforeHandle[i]!(ctx)
    if (outcome instanceof Promise) {
      return continueProgram(
        host,
        entry,
        program,
        source,
        ctx,
        finalize,
        wrapResponse,
        { kind: "before", next: i + 1 },
        outcome,
        initial,
      )
    }
    if (outcome !== undefined) return finalize(outcome, responseSet(ctx))
  }

  const output = program.handler(ctx)
  if (output instanceof Promise) {
    return continueProgram(
      host,
      entry,
      program,
      source,
      ctx,
      finalize,
      wrapResponse,
      { kind: "handler" },
      output,
      initial,
    )
  }
  let result = output
  for (let i = afterIndex; i < program.afterHandle.length; i++) {
    const outcome = program.afterHandle[i]!(result, ctx)
    if (outcome instanceof Promise) {
      return continueProgram(
        host,
        entry,
        program,
        source,
        ctx,
        finalize,
        wrapResponse,
        { kind: "after", next: i + 1 },
        outcome,
        result,
      )
    }
    result = outcome
  }
  return host.finishProgramResult(entry, ctx, result, finalize, wrapResponse)
}

async function continueProgram<T>(
  host: RouteProgramRuntime,
  entry: RouteEntry,
  program: RouteProgram,
  source: RequestSource,
  ctx: RawContext,
  finalize: (result: unknown, set: CtxSet) => T,
  wrapResponse: (response: Response | ResponseResult) => T,
  pendingPhase: PendingPhase,
  pending: Promise<unknown>,
  initial: unknown,
): Promise<T> {
  try {
    const settled = await pending
    let result = initial
    if (pendingPhase.kind === "validation") {
      if (settled !== undefined) return wrapResponse(settled as Response | ResponseResult)
    } else if (pendingPhase.kind === "derive") {
      if (isEarly(settled)) return finalize(settled, responseSet(ctx))
      Object.assign(ctx, settled)
    } else if (pendingPhase.kind === "before") {
      if (settled !== undefined) return finalize(settled, responseSet(ctx))
    } else if (pendingPhase.kind === "handler") {
      result = settled
    } else {
      result = settled
    }
    return await runAsyncStages(
      host,
      entry,
      program,
      source,
      ctx,
      finalize,
      wrapResponse,
      pendingPhase,
      result,
    )
  } catch (error) {
    return await host.handleProgramError(entry, error, ctx, finalize, wrapResponse)
  }
}

async function runAsyncStages<T>(
  host: RouteProgramRuntime,
  entry: RouteEntry,
  program: RouteProgram,
  source: RequestSource,
  ctx: RawContext,
  finalize: (result: unknown, set: CtxSet) => T,
  wrapResponse: (response: Response | ResponseResult) => T,
  pendingPhase: PendingPhase,
  result: unknown,
): Promise<T> {
  try {
    if (pendingPhase.kind === "validation") {
      const validations = program.validationStages
      for (let i = pendingPhase.next; i < validations.length; i++) {
        const stage = validations[i]!
        const outcome =
          stage.kind === "body"
            ? await host.readProgramBody(entry, source, ctx)
            : host.validateProgramStage(entry, stage, source, ctx)
        const settled = outcome instanceof Promise ? await outcome : outcome
        if (settled !== undefined) return wrapResponse(settled)
      }
    }

    const deriveStart = pendingPhase.kind === "derive" ? pendingPhase.next : 0
    if (pendingPhase.kind === "validation" || pendingPhase.kind === "derive") {
      for (let i = deriveStart; i < program.derives.length; i++) {
        const outcome = program.derives[i]!(ctx)
        const settled = outcome instanceof Promise ? await outcome : outcome
        if (isEarly(settled)) return finalize(settled, responseSet(ctx))
        Object.assign(ctx, settled)
      }
    }

    const beforeStart = pendingPhase.kind === "before" ? pendingPhase.next : 0
    if (
      pendingPhase.kind === "validation" ||
      pendingPhase.kind === "derive" ||
      pendingPhase.kind === "before"
    ) {
      for (let i = beforeStart; i < program.beforeHandle.length; i++) {
        const outcome = program.beforeHandle[i]!(ctx)
        const settled = outcome instanceof Promise ? await outcome : outcome
        if (settled !== undefined) return finalize(settled, responseSet(ctx))
      }
      const output = program.handler(ctx)
      result = output instanceof Promise ? await output : output
    }

    const afterStart = pendingPhase.kind === "after" ? pendingPhase.next : 0
    for (let i = afterStart; i < program.afterHandle.length; i++) {
      const outcome = program.afterHandle[i]!(result, ctx)
      result = outcome instanceof Promise ? await outcome : outcome
    }
    return await host.finishProgramResult(entry, ctx, result, finalize, wrapResponse)
  } catch (error) {
    return await host.handleProgramError(entry, error, ctx, finalize, wrapResponse)
  }
}
