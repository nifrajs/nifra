/**
 * @nifrajs/budget — portable request-deadline mechanics.
 *
 * A wire deadline is an absolute wall-clock instant so every hop shares one end time. Once admitted,
 * remaining time is measured against a monotonic clock so NTP or manual wall-clock changes cannot
 * add time back to an in-flight request. Policy (retry count, provider choice, tenant spend) stays out.
 */

/** Canonical wire header carrying an absolute Unix epoch deadline in milliseconds. */
export const NIFRA_DEADLINE_HEADER = "x-nifra-deadline"

/** The only clocks deadline mechanics need. Inject both for deterministic tests. */
export interface BudgetClock {
  /** Monotonic milliseconds; must never move backwards during the process lifetime. */
  monotonic(): number
  /** Unix epoch milliseconds; used only to translate an absolute wire deadline on admission. */
  wall(): number
}

/** A time budget shared by one request and every downstream hop it initiates. */
export interface RequestBudget {
  /** Absolute Unix epoch deadline for wire propagation. */
  readonly deadline: number
  /** The request cancellation signal. Nifra drives this when its effective deadline elapses. */
  readonly signal: AbortSignal
  /** Non-negative milliseconds remaining, measured with the monotonic clock. */
  remaining(): number
  /** A view that finishes `reserveMs` before this budget, preserving time for response cleanup. */
  child(reserveMs: number): RequestBudget
}

export type DeadlineHeaderResult =
  | { readonly ok: true; readonly deadline: number }
  | { readonly ok: false; readonly reason: "missing" | "malformed" }

const MISSING_DEADLINE: DeadlineHeaderResult = Object.freeze({ ok: false, reason: "missing" })
const MALFORMED_DEADLINE: DeadlineHeaderResult = Object.freeze({ ok: false, reason: "malformed" })
const UNBOUNDED_ADMISSION: DeadlineAdmission = Object.freeze({
  ok: true,
  inherited: false,
  timeoutMs: 0,
})

/** DOM-lib-independent subset accepted by the Web `Headers` constructor. */
export type DeadlineHeadersInit =
  | Headers
  | Readonly<Record<string, string>>
  | string[][]
  | undefined

export interface CreateRequestBudgetOptions {
  /** Absolute Unix epoch deadline. */
  readonly deadline: number
  readonly signal: AbortSignal
  readonly clock?: BudgetClock
}

export interface DeadlineAdmissionOptions {
  /** Local request timeout. `0` keeps requests without a wire deadline unbounded. */
  readonly localTimeoutMs?: number
  /** Hard cap for a request carrying the wire header. Default 30 seconds. */
  readonly maxInboundDeadlineMs?: number
  /** Injected wall clock for deterministic admission tests. */
  readonly wallNow?: () => number
}

export type DeadlineAdmission =
  | {
      readonly ok: true
      readonly inherited: boolean
      readonly timeoutMs: number
      /** Absent only for the unbounded no-header/no-local-timeout case. */
      readonly deadline?: number
    }
  | {
      readonly ok: false
      readonly status: 400 | 408
      readonly reason: "malformed_deadline" | "deadline_exceeded"
    }

/** Sentinel used only for an unbounded local budget. It is never written to the wire. */
export const UNBOUNDED_DEADLINE = Number.MAX_SAFE_INTEGER

export class DeadlineExceededError extends Error {
  readonly code = "NIFRA_DEADLINE_EXCEEDED" as const
  readonly status = 504 as const

  constructor(
    public readonly remainingMs: number,
    public readonly requiredMs: number,
  ) {
    super(`request deadline exceeded: ${remainingMs}ms remaining, ${requiredMs}ms required`)
    this.name = "DeadlineExceededError"
  }
}

const systemClock: BudgetClock = {
  monotonic: () => globalThis.performance?.now?.() ?? Date.now(),
  wall: () => Date.now(),
}

const assertFiniteNonNegative = (name: string, value: number): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`@nifrajs/budget: ${name} must be a finite non-negative number`)
  }
}

const assertDeadline = (deadline: number): void => {
  if (!Number.isSafeInteger(deadline) || deadline <= 0) {
    throw new RangeError("@nifrajs/budget: deadline must be a positive safe-integer epoch-ms value")
  }
}

class MonotonicRequestBudget implements RequestBudget {
  constructor(
    readonly deadline: number,
    readonly signal: AbortSignal,
    private readonly monotonicDeadline: number,
    private readonly clock: BudgetClock,
  ) {}

  remaining(): number {
    if (this.signal.aborted) return 0
    return Math.max(0, this.monotonicDeadline - this.clock.monotonic())
  }

  child(reserveMs: number): RequestBudget {
    assertFiniteNonNegative("reserveMs", reserveMs)
    return new MonotonicRequestBudget(
      Math.max(1, Math.floor(this.deadline - reserveMs)),
      this.signal,
      this.monotonicDeadline - reserveMs,
      this.clock,
    )
  }
}

class UnboundedRequestBudget implements RequestBudget {
  readonly deadline = UNBOUNDED_DEADLINE

  constructor(readonly signal: AbortSignal) {}

  remaining(): number {
    return this.signal.aborted ? 0 : Number.POSITIVE_INFINITY
  }

  child(reserveMs: number): RequestBudget {
    assertFiniteNonNegative("reserveMs", reserveMs)
    return this
  }
}

/**
 * Create a budget from an admitted absolute deadline. Wall time is sampled once; every subsequent
 * `remaining()` call is monotonic. This function does not arm a timer—the owner of `signal` does.
 */
export function createRequestBudget(options: CreateRequestBudgetOptions): RequestBudget {
  assertDeadline(options.deadline)
  const clock = options.clock ?? systemClock
  const wallAtStart = clock.wall()
  const monotonicAtStart = clock.monotonic()
  const admittedRemaining = Math.max(0, options.deadline - wallAtStart)
  return new MonotonicRequestBudget(
    options.deadline,
    options.signal,
    monotonicAtStart + admittedRemaining,
    clock,
  )
}

/** Create a local no-deadline view. Outbound header propagation deliberately omits it. */
export function createUnboundedRequestBudget(signal: AbortSignal): RequestBudget {
  return new UnboundedRequestBudget(signal)
}

/** Parse the canonical deadline header without trusting or clamping it. */
export function parseDeadlineHeader(headers: Headers): DeadlineHeaderResult {
  const raw = headers.get(NIFRA_DEADLINE_HEADER)
  if (raw === null) return MISSING_DEADLINE
  // A comma means multiple values were folded together. Ambiguous deadlines fail closed.
  if (!/^[1-9]\d*$/.test(raw)) return MALFORMED_DEADLINE
  const deadline = Number(raw)
  if (!Number.isSafeInteger(deadline)) return MALFORMED_DEADLINE
  return { ok: true, deadline }
}

/**
 * Validate and clamp an inbound absolute deadline. This is pure admission mechanics: callers supply
 * local policy, then own the timer that drives their existing cancellation signal.
 */
export function admitDeadline(
  headers: Headers,
  options: DeadlineAdmissionOptions = {},
): DeadlineAdmission {
  const localTimeoutMs = options.localTimeoutMs ?? 0
  const maxInboundDeadlineMs = options.maxInboundDeadlineMs ?? 30_000
  assertFiniteNonNegative("localTimeoutMs", localTimeoutMs)
  if (!Number.isFinite(maxInboundDeadlineMs) || maxInboundDeadlineMs <= 0) {
    throw new RangeError("@nifrajs/budget: maxInboundDeadlineMs must be a finite positive number")
  }

  const parsed = parseDeadlineHeader(headers)
  if (!parsed.ok) {
    if (parsed.reason === "malformed") {
      return { ok: false, status: 400, reason: "malformed_deadline" }
    }
    if (localTimeoutMs <= 0) return UNBOUNDED_ADMISSION
    const now = options.wallNow?.() ?? Date.now()
    return {
      ok: true,
      inherited: false,
      timeoutMs: localTimeoutMs,
      deadline: Math.floor(now + localTimeoutMs),
    }
  }

  const now = options.wallNow?.() ?? Date.now()
  const clientRemaining = parsed.deadline - now
  if (clientRemaining <= 0) {
    return { ok: false, status: 408, reason: "deadline_exceeded" }
  }
  const localCap =
    localTimeoutMs > 0 ? Math.min(localTimeoutMs, maxInboundDeadlineMs) : maxInboundDeadlineMs
  const timeoutMs = Math.max(1, Math.min(clientRemaining, localCap))
  return {
    ok: true,
    inherited: true,
    timeoutMs,
    deadline: Math.floor(Math.min(parsed.deadline, now + localCap)),
  }
}

/** Add this budget's absolute deadline to an outbound request. */
export function withDeadlineHeader(
  input: DeadlineHeadersInit,
  budget: RequestBudget,
  reserveMs = 0,
): Headers {
  assertFiniteNonNegative("reserveMs", reserveMs)
  const headers = new Headers(input)
  if (!Number.isFinite(budget.remaining())) return headers
  const deadline = Math.max(1, Math.floor(budget.deadline - reserveMs))
  headers.set(NIFRA_DEADLINE_HEADER, String(deadline))
  return headers
}

/** Fail before starting work that cannot fit inside the remaining time. */
export function assertBudgetRemaining(budget: RequestBudget, requiredMs = 0): void {
  assertFiniteNonNegative("requiredMs", requiredMs)
  const remaining = budget.remaining()
  if (remaining <= requiredMs) throw new DeadlineExceededError(remaining, requiredMs)
}

/** True only when a new attempt plus a caller-owned reserve can still fit. */
export function canAttempt(
  budget: RequestBudget,
  estimatedAttemptMs: number,
  reserveMs = 0,
): boolean {
  assertFiniteNonNegative("estimatedAttemptMs", estimatedAttemptMs)
  assertFiniteNonNegative("reserveMs", reserveMs)
  return budget.remaining() > estimatedAttemptMs + reserveMs
}
