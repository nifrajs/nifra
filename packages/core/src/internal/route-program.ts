/**
 * Registration-compiled general route program.
 *
 * This is deliberately a data-and-control-flow compiler, not source generation: user functions and
 * schemas remain opaque references and no request value is ever converted into executable code. The
 * program is frozen at registration so the request path walks one immutable stage sequence instead
 * of rediscovering which lifecycle features are present.
 */

import type { StandardSchemaV1 } from "../schema/standard.ts"
import { markAuthenticatedRequest } from "../server/auth.ts"
import { declaredHeaderNames } from "../server/headers.ts"
import { pathnameOf } from "../server/http.ts"
import type { Logger } from "../server/logger.ts"
import { queryObjectOf } from "../server/query.ts"
import { toResponse } from "../server/respond.ts"
import {
  CONTEXT_SEARCH,
  CONTEXT_SET,
  EMPTY_RESPONSE_CONTROLS,
  isResponseResult,
  type ResponseResult,
  requestOf,
  status,
} from "../server/runtime-core.ts"
import type { CtxSet, MaybePromise, RawContext, RequestSource } from "../server/server.ts"
import type {
  InternalHandler,
  RawAfterHandle,
  RawAuthStage,
  RawBeforeHandle,
  RawDerive,
  RawErrorHandler,
  RouteEntry,
} from "./route-execution.ts"

export type ProgramValidationKind = "headers" | "cookies" | "params" | "body" | "query"

export type RouteProgramStage =
  | {
      readonly kind: ProgramValidationKind
      readonly schema: StandardSchemaV1
      /** Headers only: the names a closed schema validates, read case-insensitively. */
      readonly names?: readonly string[] | undefined
    }
  | { readonly kind: "derive"; readonly run: RawDerive }
  | { readonly kind: "before"; readonly run: RawBeforeHandle }
  | { readonly kind: "handler"; readonly run: InternalHandler }
  | { readonly kind: "after"; readonly run: RawAfterHandle }

/** The complete registration-time lifecycle, in semantic execution order. */
export interface RouteProgram {
  readonly stages: readonly RouteProgramStage[]
  readonly validationOrder: "validate-before-auth" | "auth-before-validation"
  readonly authBeforeValidation: boolean
  readonly authStages: readonly RawAuthStage[]
  /** Protected route fast lane: auth plus validation/handler, with no general lifecycle hooks. */
  readonly authFastLane: boolean
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
  readonly authStages?: readonly RawAuthStage[]
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
  const authStages = input.authStages ?? []
  const authBeforeValidation =
    authStages.length > 0
      ? schema?.validationOrder !== "validate-before-auth"
      : schema?.validationOrder === "auth-before-validation"
  for (const kind of ["headers", "cookies", "params", "body", "query"] as const) {
    const validator = schema?.[kind]
    if (validator !== undefined) {
      const names = kind === "headers" ? declaredHeaderNames(validator) : undefined
      const stage = { kind, schema: validator, names }
      stages.push(stage)
      validationStages.push(stage)
    }
  }
  for (const derive of input.derives) stages.push({ kind: "derive", run: derive })
  for (const before of input.beforeHandle) stages.push({ kind: "before", run: before })
  stages.push({ kind: "handler", run: input.handler })
  for (const after of input.afterHandle) stages.push({ kind: "after", run: after })

  return Object.freeze({
    stages: Object.freeze(stages),
    validationOrder: authBeforeValidation ? "auth-before-validation" : "validate-before-auth",
    authBeforeValidation,
    authStages: Object.freeze([...authStages]),
    authFastLane:
      authStages.length > 0 &&
      input.derives.length === 0 &&
      input.beforeHandle.length === 0 &&
      input.afterHandle.length === 0,
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
    finalize: (result: unknown, set: CtxSet, ctx?: RawContext) => T,
    wrapResponse: (response: Response | ResponseResult) => T,
    fallback?: () => T,
  ): MaybePromise<T>
  finishProgramResult<T>(
    entry: RouteEntry,
    ctx: RawContext,
    result: unknown,
    finalize: (result: unknown, set: CtxSet, ctx?: RawContext) => T,
    wrapResponse: (response: Response | ResponseResult) => T,
  ): MaybePromise<T>
  /** Installed by `idempotency()`, and present whenever a route resolved idempotency. */
  readonly idempotencyRuntime: {
    gate<T>(
      entry: RouteEntry,
      ctx: RawContext,
      wrapResponse: (response: Response | ResponseResult) => T,
      resume: IdempotencyResume<T>,
      fail: (error: unknown) => MaybePromise<T>,
    ): Promise<T>
  }
}

/**
 * The rest of a program after the idempotency gate. The gate continues it with the request it
 * buffered, and with a replay entry and program when the key already holds a response.
 */
export type IdempotencyResume<T> = (entry: RouteEntry, program: RouteProgram) => ProgramResult<T>

/** Idempotency infrastructure failures use the same boundary as the resumed route program. */
function runIdempotencyGate<T>(
  host: RouteProgramRuntime,
  entry: RouteEntry,
  ctx: RawContext,
  finalize: (result: unknown, set: CtxSet, ctx?: RawContext) => T,
  wrapResponse: (response: Response | ResponseResult) => T,
  resume: IdempotencyResume<T>,
): Promise<T> {
  return host.idempotencyRuntime.gate(entry, ctx, wrapResponse, resume, (error) =>
    host.handleProgramError(entry, error, ctx, finalize, wrapResponse),
  )
}

function responseSet(ctx: RawContext): CtxSet {
  return ctx[CONTEXT_SET]() ?? EMPTY_RESPONSE_CONTROLS
}

function isEarly(value: unknown): value is Response | ResponseResult {
  return value instanceof Response || isResponseResult(value)
}

/** A hook's early reply. A `status(...)` or `c.json(...)` one is held to the route's response
 * contract like the handler's. */
function finishEarly<T>(
  host: RouteProgramRuntime,
  entry: RouteEntry,
  ctx: RawContext,
  value: unknown,
  finalize: (result: unknown, set: CtxSet, ctx?: RawContext) => T,
  wrapResponse: (response: Response | ResponseResult) => T,
): ProgramResult<T> {
  return entry.responseContract !== undefined &&
    (value === ctx.jsonReply || isResponseResult(value))
    ? host.finishProgramResult(entry, ctx, value, finalize, wrapResponse)
    : finalize(value, responseSet(ctx), ctx)
}

function authHeadersOf(source: RequestSource): import("../server/auth.ts").AuthHeaders {
  return Object.freeze({
    get: (name: string) => source.headers.get(name),
    has: (name: string) => source.headers.has(name),
    forEach: (callback: (value: string, name: string) => void) => {
      source.headers.forEach(callback)
    },
  })
}

/** A fresh parse of `search`, frozen with its arrays, so a stage never holds what validation reads. */
function frozenQueryOf(search: string): Readonly<Record<string, string | readonly string[]>> {
  const query = queryObjectOf(search)
  for (const key in query) {
    const value = query[key]
    if (Array.isArray(value)) Object.freeze(value)
  }
  return Object.freeze(query)
}

function authenticationInputOf(
  source: RequestSource,
  ctx: RawContext,
): import("../server/auth.ts").AuthenticationInput<unknown> {
  let query: Readonly<Record<string, string | readonly string[]>> | undefined
  // Accessors, so a stage that reads neither the query nor the request costs nothing for them; the
  // search is the context's own, the one `c.query` and its validation parse.
  return Object.freeze({
    method: source.method,
    pathname: pathnameOf(source.url),
    headers: authHeadersOf(source),
    params: Object.freeze({ ...ctx.params }),
    get search() {
      return ctx[CONTEXT_SEARCH]
    },
    get query() {
      query ??= frozenQueryOf(ctx[CONTEXT_SEARCH])
      return query
    },
    get request() {
      return ctx.req
    },
    env: ctx.env,
    clientIp: ctx.clientIp,
    signal: ctx.signal,
  })
}

/**
 * Run the `authenticate()` stages a mount was registered after, in order, against the request the
 * mount would receive: `undefined` once each one authenticated, else the response that refuses it. A
 * stage that throws or decides nothing valid answers 503, and its cause goes to `logger`, as a route
 * error no hook answers does.
 */
export function authenticateMount(
  stages: readonly RawAuthStage[],
  request: Request,
  platform: { readonly env?: unknown; readonly clientIp?: string | undefined } | undefined,
  logger: Logger,
): MaybePromise<Response | undefined> {
  let query: Readonly<Record<string, string | readonly string[]>> | undefined
  const search = (() => {
    const at = request.url.indexOf("?")
    return at === -1 ? "" : request.url.slice(at)
  })()
  const input = Object.freeze({
    method: request.method,
    pathname: pathnameOf(request.url),
    headers: authHeadersOf(request),
    params: Object.freeze({}),
    search,
    get query() {
      query ??= frozenQueryOf(search)
      return query
    },
    request,
    env: platform?.env,
    clientIp: platform?.clientIp,
    signal: request.signal,
  })
  const unavailable = (error: unknown): Response => {
    logger.error("authenticate() stage failed before a mount", {
      method: request.method,
      path: input.pathname,
      error: error instanceof Error ? error.message : String(error),
    })
    return toResponse(defaultAuthenticationResponse("unavailable"), EMPTY_RESPONSE_CONTROLS)
  }
  const decide = (
    index: number,
    result: import("../server/auth.ts").AuthenticationResult<unknown>,
  ): MaybePromise<Response | undefined> => {
    if (!isAuthenticationDecision(result)) {
      const id = stages[index]?.id
      return unavailable(new TypeError(`authenticate() stage "${id}" returned an invalid decision`))
    }
    if (result.kind === "rejected") {
      const refusal = result.response ?? defaultAuthenticationResponse(result.reason)
      return refusal instanceof Response ? refusal : toResponse(refusal, EMPTY_RESPONSE_CONTROLS)
    }
    markAuthenticatedRequest(request)
    return run(index + 1)
  }
  const run = (index: number): MaybePromise<Response | undefined> => {
    const stage = stages[index]
    if (stage === undefined) return undefined
    let outcome: MaybePromise<import("../server/auth.ts").AuthenticationResult<unknown>>
    try {
      outcome = stage.run(input)
    } catch (error) {
      return unavailable(error)
    }
    return outcome instanceof Promise
      ? outcome.then((settled) => decide(index, settled), unavailable)
      : decide(index, outcome)
  }
  return run(0)
}

function defaultAuthenticationResponse(
  reason: import("../server/auth.ts").AuthenticationFailureReason | undefined,
): ResponseResult {
  if (reason === "forbidden") return status(403, { ok: false, error: "forbidden" })
  if (reason === "unavailable") return status(503, { ok: false, error: "auth_unavailable" })
  return status(401, { ok: false, error: "unauthorized" })
}

/** Whether a stage returned a decision it may: a rejection with a known reason and a response, if
 * any, that answers; or a principal. */
function isAuthenticationDecision(
  result: import("../server/auth.ts").AuthenticationResult<unknown>,
): boolean {
  return (
    result !== null &&
    typeof result === "object" &&
    (result.kind === "rejected"
      ? validAuthenticationFailureReason(result.reason) &&
        (result.response === undefined ||
          result.response instanceof Response ||
          isResponseResult(result.response))
      : result.kind === "authenticated" &&
        result.principal !== null &&
        result.principal !== undefined)
  )
}

function validAuthenticationFailureReason(
  value: unknown,
): value is import("../server/auth.ts").AuthenticationFailureReason | undefined {
  return (
    value === undefined ||
    value === "unauthenticated" ||
    value === "forbidden" ||
    value === "unavailable"
  )
}

/** A failed stage still answers 503, but its cause takes the handler-error path (onError, else the
 * logger) instead of vanishing. */
function failAuthentication<T>(
  host: RouteProgramRuntime,
  entry: RouteEntry,
  ctx: RawContext,
  finalize: (result: unknown, set: CtxSet, ctx?: RawContext) => T,
  wrapResponse: (response: Response | ResponseResult) => T,
  error: unknown,
): ProgramResult<T> {
  return host.handleProgramError(entry, error, ctx, finalize, wrapResponse, () =>
    finalize(defaultAuthenticationResponse("unavailable"), responseSet(ctx), ctx),
  )
}

function runAuthenticationStages<T>(
  host: RouteProgramRuntime,
  entry: RouteEntry,
  program: RouteProgram,
  source: RequestSource,
  ctx: RawContext,
  finalize: (result: unknown, set: CtxSet, ctx?: RawContext) => T,
  wrapResponse: (response: Response | ResponseResult) => T,
  start = 0,
  validationComplete = false,
): ProgramResult<T> {
  if (start >= program.authStages.length) {
    // Auth-first: the idempotency gate buffers the body, so it waits for every stage to pass. It
    // resumes on an entry without the gate, so the program does not meet it twice.
    if (entry.idempotent !== undefined && !validationComplete) {
      return runIdempotencyGate(host, entry, ctx, finalize, wrapResponse, (e, p) =>
        runAuthenticationStages(
          host,
          e,
          p,
          source,
          ctx,
          finalize,
          wrapResponse,
          p.authStages.length,
        ),
      )
    }
    if (program.authFastLane) {
      const validationIndex = validationComplete ? program.validationStages.length : 0
      return runFastAuthenticatedProgram(
        host,
        entry,
        program,
        source,
        ctx,
        finalize,
        wrapResponse,
        validationIndex,
      )
    }
    return validationComplete
      ? runSync(
          host,
          entry,
          program,
          source,
          ctx,
          finalize,
          wrapResponse,
          program.validationStages.length,
          undefined,
        )
      : runValidatedProgram(host, entry, program, source, ctx, finalize, wrapResponse)
  }
  const input = authenticationInputOf(source, ctx)
  const stage = program.authStages[start]!
  let outcome: MaybePromise<import("../server/auth.ts").AuthenticationResult<unknown>>
  try {
    outcome = stage.run(input)
  } catch (error) {
    return failAuthentication(host, entry, ctx, finalize, wrapResponse, error)
  }
  if (outcome instanceof Promise) {
    return outcome.then(
      (settled) => {
        // The rest of the program runs inside this callback: a derive or handler that throws
        // synchronously would otherwise reject the request instead of reaching onError.
        try {
          return finishAuthentication(
            host,
            entry,
            program,
            source,
            ctx,
            finalize,
            wrapResponse,
            settled,
            start + 1,
            validationComplete,
          )
        } catch (error) {
          return host.handleProgramError(entry, error, ctx, finalize, wrapResponse)
        }
      },
      (error) => failAuthentication(host, entry, ctx, finalize, wrapResponse, error),
    )
  }
  return finishAuthentication(
    host,
    entry,
    program,
    source,
    ctx,
    finalize,
    wrapResponse,
    outcome,
    start + 1,
    validationComplete,
  )
}

function finishAuthentication<T>(
  host: RouteProgramRuntime,
  entry: RouteEntry,
  program: RouteProgram,
  source: RequestSource,
  ctx: RawContext,
  finalize: (result: unknown, set: CtxSet, ctx?: RawContext) => T,
  wrapResponse: (response: Response | ResponseResult) => T,
  result: import("../server/auth.ts").AuthenticationResult<unknown>,
  next: number,
  validationComplete = false,
): ProgramResult<T> {
  if (!isAuthenticationDecision(result)) {
    const id = program.authStages[next - 1]!.id
    const error = new TypeError(`authenticate() stage "${id}" returned an invalid decision`)
    return failAuthentication(host, entry, ctx, finalize, wrapResponse, error)
  }
  if (result.kind === "rejected") {
    const response = result.response ?? defaultAuthenticationResponse(result.reason)
    return finalize(response, responseSet(ctx), ctx)
  }
  Object.defineProperty(ctx, "principal", {
    value: result.principal,
    enumerable: true,
    configurable: true,
    writable: false,
  })
  markAuthenticatedRequest(requestOf(source))
  return runAuthenticationStages(
    host,
    entry,
    program,
    source,
    ctx,
    finalize,
    wrapResponse,
    next,
    validationComplete,
  )
}

/** Validate first only when a route explicitly opts out of the protected auth-first default. */
function runFastAuthenticatedProgram<T>(
  host: RouteProgramRuntime,
  entry: RouteEntry,
  program: RouteProgram,
  source: RequestSource,
  ctx: RawContext,
  finalize: (result: unknown, set: CtxSet, ctx?: RawContext) => T,
  wrapResponse: (response: Response | ResponseResult) => T,
  validationIndex: number,
): ProgramResult<T> {
  for (let i = validationIndex; i < program.validationStages.length; i++) {
    const stage = program.validationStages[i]!
    const outcome =
      stage.kind === "body"
        ? host.readProgramBody(entry, source, ctx)
        : host.validateProgramStage(entry, stage, source, ctx)
    if (outcome instanceof Promise) {
      return continueFastAuthenticatedProgram(
        host,
        entry,
        program,
        source,
        ctx,
        finalize,
        wrapResponse,
        i + 1,
        outcome,
      )
    }
    if (outcome !== undefined) return wrapResponse(outcome)
  }
  return runFastAuthenticatedHandler(host, entry, program, ctx, finalize, wrapResponse)
}

async function continueFastAuthenticatedProgram<T>(
  host: RouteProgramRuntime,
  entry: RouteEntry,
  program: RouteProgram,
  source: RequestSource,
  ctx: RawContext,
  finalize: (result: unknown, set: CtxSet, ctx?: RawContext) => T,
  wrapResponse: (response: Response | ResponseResult) => T,
  validationIndex: number,
  pending: Promise<unknown>,
): Promise<T> {
  try {
    const settled = await pending
    if (settled !== undefined) return wrapResponse(settled as Response | ResponseResult)
    const outcome = runFastAuthenticatedProgram(
      host,
      entry,
      program,
      source,
      ctx,
      finalize,
      wrapResponse,
      validationIndex,
    )
    return outcome instanceof Promise ? await outcome : outcome
  } catch (error) {
    return await host.handleProgramError(entry, error, ctx, finalize, wrapResponse)
  }
}

function runFastAuthenticatedHandler<T>(
  host: RouteProgramRuntime,
  entry: RouteEntry,
  program: RouteProgram,
  ctx: RawContext,
  finalize: (result: unknown, set: CtxSet, ctx?: RawContext) => T,
  wrapResponse: (response: Response | ResponseResult) => T,
): ProgramResult<T> {
  let result: unknown
  try {
    result = program.handler(ctx)
  } catch (error) {
    return host.handleProgramError(entry, error, ctx, finalize, wrapResponse)
  }
  if (result instanceof Promise) {
    return result.then(
      (value) => host.finishProgramResult(entry, ctx, value, finalize, wrapResponse),
      (error) => host.handleProgramError(entry, error, ctx, finalize, wrapResponse),
    )
  }
  return host.finishProgramResult(entry, ctx, result, finalize, wrapResponse)
}

function runValidationBeforeAuthentication<T>(
  host: RouteProgramRuntime,
  entry: RouteEntry,
  program: RouteProgram,
  source: RequestSource,
  ctx: RawContext,
  finalize: (result: unknown, set: CtxSet, ctx?: RawContext) => T,
  wrapResponse: (response: Response | ResponseResult) => T,
  validationIndex = 0,
): ProgramResult<T> {
  for (let i = validationIndex; i < program.validationStages.length; i++) {
    const stage = program.validationStages[i]!
    const outcome =
      stage.kind === "body"
        ? host.readProgramBody(entry, source, ctx)
        : host.validateProgramStage(entry, stage, source, ctx)
    if (outcome instanceof Promise) {
      return continueValidationBeforeAuthentication(
        host,
        entry,
        program,
        source,
        ctx,
        finalize,
        wrapResponse,
        i + 1,
        outcome,
      )
    }
    if (outcome !== undefined) return wrapResponse(outcome)
  }
  return runAuthenticationStages(host, entry, program, source, ctx, finalize, wrapResponse, 0, true)
}

async function continueValidationBeforeAuthentication<T>(
  host: RouteProgramRuntime,
  entry: RouteEntry,
  program: RouteProgram,
  source: RequestSource,
  ctx: RawContext,
  finalize: (result: unknown, set: CtxSet, ctx?: RawContext) => T,
  wrapResponse: (response: Response | ResponseResult) => T,
  validationIndex: number,
  pending: Promise<unknown>,
): Promise<T> {
  try {
    const settled = await pending
    if (settled !== undefined) return wrapResponse(settled as Response | ResponseResult)
    const outcome = runValidationBeforeAuthentication(
      host,
      entry,
      program,
      source,
      ctx,
      finalize,
      wrapResponse,
      validationIndex,
    )
    return outcome instanceof Promise ? await outcome : outcome
  } catch (error) {
    return await host.handleProgramError(entry, error, ctx, finalize, wrapResponse)
  }
}

function runValidatedProgram<T>(
  host: RouteProgramRuntime,
  entry: RouteEntry,
  program: RouteProgram,
  source: RequestSource,
  ctx: RawContext,
  finalize: (result: unknown, set: CtxSet, ctx?: RawContext) => T,
  wrapResponse: (response: Response | ResponseResult) => T,
): ProgramResult<T> {
  if (program.hasDecorations) Object.assign(ctx, program.decorations)
  return runSync(host, entry, program, source, ctx, finalize, wrapResponse, 0, undefined)
}

type ProgramResult<T> = MaybePromise<T>

/** Opt-in sensitive-route lane: run authentication/policy hooks before parsing untrusted input. */
function runAuthBeforeValidation<T>(
  host: RouteProgramRuntime,
  entry: RouteEntry,
  program: RouteProgram,
  source: RequestSource,
  ctx: RawContext,
  finalize: (result: unknown, set: CtxSet, ctx?: RawContext) => T,
  wrapResponse: (response: Response | ResponseResult) => T,
  gated = false,
  deriveStart = 0,
  beforeStart = 0,
  validationStart = 0,
): ProgramResult<T> {
  try {
    if (!gated) {
      if (deriveStart === 0 && beforeStart === 0 && program.hasDecorations)
        Object.assign(ctx, program.decorations)

      for (let i = deriveStart; i < program.derives.length; i++) {
        const result = program.derives[i]!(ctx)
        if (result instanceof Promise) {
          return continueProgram(
            host,
            entry,
            program,
            source,
            ctx,
            finalize,
            wrapResponse,
            { kind: "derive", next: i + 1, policy: true },
            result,
            undefined,
          )
        }
        if (isEarly(result)) return finishEarly(host, entry, ctx, result, finalize, wrapResponse)
        Object.assign(ctx, result)
      }

      for (let i = beforeStart; i < program.beforeHandle.length; i++) {
        const result = program.beforeHandle[i]!(ctx)
        if (result instanceof Promise) {
          return continueProgram(
            host,
            entry,
            program,
            source,
            ctx,
            finalize,
            wrapResponse,
            { kind: "before", next: i + 1, policy: true },
            result,
            undefined,
          )
        }
        if (result !== undefined)
          return finishEarly(host, entry, ctx, result, finalize, wrapResponse)
      }

      // The policy hooks have passed, so the idempotency gate may buffer the body now. Not awaited:
      // the gate reports its own failures, and one the resumed program let escape must skip this catch.
      if (entry.idempotent !== undefined) {
        return runIdempotencyGate(host, entry, ctx, finalize, wrapResponse, (e, p) =>
          runAuthBeforeValidation(host, e, p, source, ctx, finalize, wrapResponse, true),
        )
      }
    }

    for (let i = validationStart; i < program.validationStages.length; i++) {
      const stage = program.validationStages[i]!
      const result =
        stage.kind === "body"
          ? host.readProgramBody(entry, source, ctx)
          : host.validateProgramStage(entry, stage, source, ctx)
      if (result instanceof Promise) {
        return continueProgram(
          host,
          entry,
          program,
          source,
          ctx,
          finalize,
          wrapResponse,
          { kind: "validation", next: i + 1, policy: true },
          result,
          undefined,
        )
      }
      if (result !== undefined) return wrapResponse(result)
    }

    // A pending outcome here already met the error boundary (continueProgram or the response
    // contract), so wrapping it in another catch would only add a promise.
    return runHooksSync(
      host,
      entry,
      program,
      source,
      ctx,
      finalize,
      wrapResponse,
      program.derives.length,
      program.beforeHandle.length,
      undefined,
    )
  } catch (error) {
    return host.handleProgramError(entry, error, ctx, finalize, wrapResponse)
  }
}

type PendingPhase =
  | { readonly kind: "validation"; readonly next: number; readonly policy?: true }
  | { readonly kind: "derive"; readonly next: number; readonly policy?: true }
  | { readonly kind: "before"; readonly next: number; readonly policy?: true }
  | { readonly kind: "handler" }
  | { readonly kind: "after"; readonly next: number }

/** Execute the general program. The first synchronous stage sequence stays synchronous. */
export function executeRouteProgram<T>(
  runtime: object,
  entry: RouteEntry,
  program: RouteProgram,
  source: RequestSource,
  ctx: RawContext,
  finalize: (result: unknown, set: CtxSet, ctx?: RawContext) => T,
  wrapResponse: (response: Response | ResponseResult) => T,
): ProgramResult<T> {
  const host = runtime as RouteProgramRuntime
  // An auth-first program meets the idempotency gate once authentication has passed, so the gate
  // never buffers a body for a caller it would refuse. Every other program meets it first.
  if (entry.idempotent !== undefined && !program.authBeforeValidation) {
    return runIdempotencyGate(host, entry, ctx, finalize, wrapResponse, (e, p) =>
      executeRouteProgram(runtime, e, p, source, ctx, finalize, wrapResponse),
    )
  }
  try {
    if (program.authStages.length > 0) {
      if (program.hasDecorations) Object.assign(ctx, program.decorations)
      return program.authBeforeValidation
        ? runAuthenticationStages(host, entry, program, source, ctx, finalize, wrapResponse)
        : runValidationBeforeAuthentication(
            host,
            entry,
            program,
            source,
            ctx,
            finalize,
            wrapResponse,
          )
    }
    if (program.validationOrder === "auth-before-validation") {
      return runAuthBeforeValidation(host, entry, program, source, ctx, finalize, wrapResponse)
    }
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
  finalize: (result: unknown, set: CtxSet, ctx?: RawContext) => T,
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
  return runHooksSync(host, entry, program, source, ctx, finalize, wrapResponse, 0, 0, initial)
}

function runHooksSync<T>(
  host: RouteProgramRuntime,
  entry: RouteEntry,
  program: RouteProgram,
  source: RequestSource,
  ctx: RawContext,
  finalize: (result: unknown, set: CtxSet, ctx?: RawContext) => T,
  wrapResponse: (response: Response | ResponseResult) => T,
  deriveIndex: number,
  beforeIndex: number,
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
    if (isEarly(outcome)) return finishEarly(host, entry, ctx, outcome, finalize, wrapResponse)
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
    if (outcome !== undefined) return finishEarly(host, entry, ctx, outcome, finalize, wrapResponse)
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
  return runAfterSync(host, entry, program, source, ctx, finalize, wrapResponse, 0, output)
}

function runAfterSync<T>(
  host: RouteProgramRuntime,
  entry: RouteEntry,
  program: RouteProgram,
  source: RequestSource,
  ctx: RawContext,
  finalize: (result: unknown, set: CtxSet, ctx?: RawContext) => T,
  wrapResponse: (response: Response | ResponseResult) => T,
  afterIndex: number,
  result: unknown,
): ProgramResult<T> {
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
  finalize: (result: unknown, set: CtxSet, ctx?: RawContext) => T,
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
      if (isEarly(settled)) return finishEarly(host, entry, ctx, settled, finalize, wrapResponse)
      Object.assign(ctx, settled)
    } else if (pendingPhase.kind === "before") {
      if (settled !== undefined)
        return finishEarly(host, entry, ctx, settled, finalize, wrapResponse)
    } else if (pendingPhase.kind === "handler") {
      result = settled
    } else {
      result = settled
    }
    const outcome = runAsyncStages(
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
    return outcome instanceof Promise ? await outcome : outcome
  } catch (error) {
    return await host.handleProgramError(entry, error, ctx, finalize, wrapResponse)
  }
}

function runAsyncStages<T>(
  host: RouteProgramRuntime,
  entry: RouteEntry,
  program: RouteProgram,
  source: RequestSource,
  ctx: RawContext,
  finalize: (result: unknown, set: CtxSet, ctx?: RawContext) => T,
  wrapResponse: (response: Response | ResponseResult) => T,
  pendingPhase: PendingPhase,
  result: unknown,
): ProgramResult<T> {
  // After an actual async boundary, resume the same sync runner until the next pending stage.
  // Sync hooks and finalization need no async function wrapper or additional microtask turn.
  if (pendingPhase.kind === "validation") {
    if (pendingPhase.policy) {
      return runAuthBeforeValidation(
        host,
        entry,
        program,
        source,
        ctx,
        finalize,
        wrapResponse,
        true,
        0,
        0,
        pendingPhase.next,
      )
    }
    return runSync(
      host,
      entry,
      program,
      source,
      ctx,
      finalize,
      wrapResponse,
      pendingPhase.next,
      result,
    )
  }
  if (pendingPhase.kind === "derive" || pendingPhase.kind === "before") {
    if (pendingPhase.policy) {
      return runAuthBeforeValidation(
        host,
        entry,
        program,
        source,
        ctx,
        finalize,
        wrapResponse,
        false,
        pendingPhase.kind === "derive" ? pendingPhase.next : program.derives.length,
        pendingPhase.kind === "before" ? pendingPhase.next : 0,
      )
    }
    return runHooksSync(
      host,
      entry,
      program,
      source,
      ctx,
      finalize,
      wrapResponse,
      pendingPhase.kind === "derive" ? pendingPhase.next : program.derives.length,
      pendingPhase.kind === "before" ? pendingPhase.next : 0,
      result,
    )
  }
  return runAfterSync(
    host,
    entry,
    program,
    source,
    ctx,
    finalize,
    wrapResponse,
    pendingPhase.kind === "after" ? pendingPhase.next : 0,
    result,
  )
}
