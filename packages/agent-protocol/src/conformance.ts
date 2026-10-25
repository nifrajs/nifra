/**
 * A conformance kit for `AgentBackend` implementations: it drives a backend through the scenarios a
 * host relies on and reports each check, so an adapter for a vendor's agent can prove it before a
 * host ships it. It uses no test runner; assert on the returned report in whichever one you use.
 */
import { type AgentBackend, type AgentSessionSnapshot, agentEventProblem } from "./index.ts"
import { isRecord } from "./internal/record.ts"

export interface AgentBackendConformanceOptions {
  /** A fresh backend for each scenario. The kit closes every session it opens. */
  readonly backend: () => AgentBackend | PromiseLike<AgentBackend>
  /** The working directory each session is created in. */
  readonly cwd: string
  /** A message the backend answers with a turn that ends by itself. */
  readonly prompt: string
  /** A message that makes the backend ask for an approval. Enables the approval checks. */
  readonly approvalPrompt?: string
  /** A message whose turn keeps running until it is cancelled. Enables the busy and cancel checks. */
  readonly slowPrompt?: string
  /** Longest one scenario may wait for the backend. Default 10 seconds. */
  readonly timeoutMs?: number
}

export type AgentConformanceStatus = "passed" | "failed" | "skipped"

export interface AgentConformanceCheck {
  readonly id: string
  readonly status: AgentConformanceStatus
  /** What went wrong, or why the check was skipped. */
  readonly detail?: string
}

export interface AgentBackendConformanceReport {
  readonly backend: string
  /** No check failed. Skipped checks do not count against it. */
  readonly ok: boolean
  readonly checks: readonly AgentConformanceCheck[]
}

type ReadOutcome = "matched" | "ended" | "threw" | "timeout"

const TERMINAL: ReadonlySet<unknown> = new Set([
  "session.completed",
  "session.failed",
  "session.stopped",
])
const DEFAULT_TIMEOUT_MS = 10_000

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function typeOf(event: unknown): unknown {
  return recordOf(event)?.type
}

/** Reads a backend's stream one event at a time, never waiting past a deadline. */
class EventReader {
  readonly events: unknown[] = []
  error: unknown
  private readonly iterator: AsyncIterator<unknown> | undefined
  private pending: Promise<IteratorResult<unknown>> | undefined
  private finished = false

  constructor(open: () => AsyncIterable<unknown>) {
    try {
      this.iterator = open()[Symbol.asyncIterator]()
    } catch (error) {
      this.error = error
      this.finished = true
    }
  }

  async readUntil(until: (event: unknown) => boolean, deadline: number): Promise<ReadOutcome> {
    for (;;) {
      if (this.finished) return this.error === undefined ? "ended" : "threw"
      const iterator = this.iterator
      if (iterator === undefined) return "ended"
      this.pending ??= iterator.next()
      const result = await settleBefore(this.pending, deadline)
      if (result === TIMED_OUT) return "timeout"
      this.pending = undefined
      if (result.kind === "error") {
        this.error = result.error ?? new Error("stream failed")
        this.finished = true
        return "threw"
      }
      if (result.value.done === true) {
        this.finished = true
        return "ended"
      }
      this.events.push(result.value.value)
      if (until(result.value.value)) return "matched"
    }
  }

  readToEnd(deadline: number): Promise<ReadOutcome> {
    return this.readUntil(() => false, deadline)
  }

  async stop(): Promise<void> {
    if (this.finished) return
    this.finished = true
    const closing = Promise.resolve()
      .then(() => this.iterator?.return?.())
      .catch(() => undefined)
    // A generator parked in an await cannot return until it resumes, so do not wait on that one.
    if (this.pending === undefined) await settleBefore(closing, Date.now() + 1_000)
  }
}

const TIMED_OUT: unique symbol = Symbol("timed out")

type Settled<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "error"; readonly error: unknown }

function settleBefore<T>(
  promise: Promise<T>,
  deadline: number,
): Promise<Settled<T> | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, deadline - Date.now()))
  })
  const settled = promise.then(
    (value): Settled<T> => ({ kind: "value", value }),
    (error: unknown): Settled<T> => ({ kind: "error", error }),
  )
  return Promise.race([settled, timeout]).finally(() => clearTimeout(timer))
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  const message = recordOf(error)?.message
  return typeof message === "string" ? message : String(error)
}

/** The first way the events break the protocol, or undefined when they are a valid turn. */
function turnProblem(
  events: readonly unknown[],
  sessionId: string,
  expectEnd: boolean,
): string | undefined {
  let lastSeq = -1
  let turnId: unknown
  for (const [index, event] of events.entries()) {
    const problem = agentEventProblem(event)
    if (problem !== undefined || !isRecord(event))
      return `event ${index}: ${problem ?? "not an object"}`
    const record = event
    if (record.sessionId !== sessionId) return `event ${index} names another session`
    const seq = typeof record.seq === "number" ? record.seq : -1
    if (seq <= lastSeq) return `event ${index} has seq ${seq} after ${lastSeq}`
    lastSeq = seq
    if (record.type === "turn.started") {
      if (turnId !== undefined) return `event ${index} starts a second turn`
      turnId = record.turnId
    } else if (record.turnId !== undefined && record.turnId !== turnId) {
      return turnId === undefined
        ? `event ${index} (${String(record.type)}) comes before turn.started`
        : `event ${index} (${String(record.type)}) names another turn`
    }
    if (TERMINAL.has(record.type) && index !== events.length - 1)
      return `event ${index} (${String(record.type)}) ends the turn but more events follow`
  }
  if (turnId === undefined) return "no turn.started event"
  if (expectEnd && !TERMINAL.has(typeOf(events.at(-1))))
    return "the stream ended without session.completed, session.failed, or session.stopped"
  return undefined
}

/**
 * Drive a backend through the scenarios a host depends on: a session's snapshot, a whole turn's
 * events (valid, in order, one turn, one terminal event), a refused second message while busy,
 * cancellation, approvals granted, denied, unknown and cancelled, and a closed session. Scenarios
 * whose prompt is not given are reported as skipped.
 */
export async function checkAgentBackend(
  options: AgentBackendConformanceOptions,
): Promise<AgentBackendConformanceReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new RangeError("checkAgentBackend: timeoutMs must be a positive integer")
  const checks: AgentConformanceCheck[] = []
  let backendName = "unknown"
  const pass = (id: string): void => {
    checks.push({ id, status: "passed" })
  }
  const fail = (id: string, detail: string): void => {
    checks.push({ id, status: "failed", detail })
  }
  const skip = (id: string, detail: string): void => {
    checks.push({ id, status: "skipped", detail })
  }

  const scenario = async (
    ids: readonly string[],
    run: (backend: AgentBackend, session: AgentSessionSnapshot, deadline: number) => Promise<void>,
  ): Promise<void> => {
    let backend: AgentBackend | undefined
    let session: AgentSessionSnapshot | undefined
    const before = checks.length
    try {
      backend = await options.backend()
      backendName = backend.info.name
      session = await backend.createSession({ cwd: options.cwd })
      await run(backend, session, Date.now() + timeoutMs)
    } catch (error) {
      const reported = new Set(checks.slice(before).map((check) => check.id))
      for (const id of ids)
        if (!reported.has(id)) fail(id, `the scenario threw: ${describe(error)}`)
    } finally {
      if (backend !== undefined && session !== undefined)
        await settleBefore(backend.close(session.id), Date.now() + timeoutMs)
    }
  }

  await scenario(
    ["session.create", "turn.events", "turn.completes", "turn.snapshot"],
    async (backend, session, deadline) => {
      const problem = agentEventProblem({
        version: 1,
        sessionId: session.id,
        seq: 0,
        at: 0,
        type: "session.started",
        snapshot: session,
      })
      if (problem !== undefined) fail("session.create", problem.replace("session.started.", ""))
      else if (session.cwd !== options.cwd)
        fail("session.create", "snapshot.cwd is not the cwd asked for")
      else if (session.status === "running")
        fail("session.create", "a new session is already running")
      else pass("session.create")

      const reader = new EventReader(() =>
        backend.send({ sessionId: session.id, message: options.prompt }),
      )
      const outcome = await reader.readToEnd(deadline)
      if (outcome === "timeout") {
        await reader.stop()
        fail("turn.events", `the turn did not end within ${timeoutMs} ms`)
        fail("turn.completes", "the turn did not end")
        skip("turn.snapshot", "the turn did not end")
        return
      }
      if (outcome === "threw") {
        fail("turn.events", `the stream threw: ${describe(reader.error)}`)
        fail("turn.completes", "the stream threw")
        skip("turn.snapshot", "the turn did not end")
        return
      }
      const eventsProblem = turnProblem(reader.events, session.id, true)
      if (eventsProblem === undefined) pass("turn.events")
      else fail("turn.events", eventsProblem)
      const last = typeOf(reader.events.at(-1))
      if (last === "session.completed") pass("turn.completes")
      else
        fail(
          "turn.completes",
          `the turn ended with ${String(last ?? "no event")}, not session.completed`,
        )
      const after = await backend.snapshot(session.id)
      if (after.id !== session.id) fail("turn.snapshot", "snapshot names another session")
      else if (after.status === "running")
        fail("turn.snapshot", "the session is still running after its turn")
      else pass("turn.snapshot")
    },
  )

  const slowPrompt = options.slowPrompt
  if (slowPrompt === undefined) {
    skip("turn.busy", "no slowPrompt")
    skip("turn.cancel", "no slowPrompt")
  } else {
    await scenario(["turn.busy"], async (backend, session, deadline) => {
      const first = new EventReader(() =>
        backend.send({ sessionId: session.id, message: slowPrompt }),
      )
      if (
        (await first.readUntil((event) => typeOf(event) === "turn.started", deadline)) !== "matched"
      ) {
        await first.stop()
        fail("turn.busy", "the slow turn never started")
        return
      }
      const second = new EventReader(() =>
        backend.send({ sessionId: session.id, message: options.prompt }),
      )
      const outcome = await second.readUntil((event) => TERMINAL.has(typeOf(event)), deadline)
      const refused =
        outcome === "threw" ||
        (outcome === "matched" &&
          second.events.length === 1 &&
          typeOf(second.events[0]) === "session.failed")
      if (!refused)
        fail("turn.busy", "a second message while a turn runs was not refused on its own stream")
      else if ((await backend.snapshot(session.id)).status !== "running")
        fail("turn.busy", "refusing the second message ended the running turn")
      else pass("turn.busy")
      await second.stop()
      await backend.cancel(session.id, "conformance")
      await first.readToEnd(deadline)
    })

    await scenario(["turn.cancel"], async (backend, session, deadline) => {
      const reader = new EventReader(() =>
        backend.send({ sessionId: session.id, message: slowPrompt }),
      )
      if (
        (await reader.readUntil((event) => typeOf(event) === "turn.started", deadline)) !==
        "matched"
      ) {
        await reader.stop()
        fail("turn.cancel", "the slow turn never started")
        return
      }
      await backend.cancel(session.id, "conformance")
      const outcome = await reader.readToEnd(deadline)
      if (outcome === "timeout") {
        await reader.stop()
        fail("turn.cancel", `the turn did not end within ${timeoutMs} ms of cancel`)
        return
      }
      const problem = turnProblem(reader.events, session.id, true)
      if (problem !== undefined) {
        fail("turn.cancel", problem)
        return
      }
      if (typeOf(reader.events.at(-1)) !== "session.stopped") {
        fail("turn.cancel", `a cancelled turn ended with ${String(typeOf(reader.events.at(-1)))}`)
        return
      }
      const next = new EventReader(() =>
        backend.send({ sessionId: session.id, message: options.prompt }),
      )
      if (
        (await next.readToEnd(deadline)) !== "ended" ||
        typeOf(next.events.at(-1)) !== "session.completed"
      ) {
        await next.stop()
        fail("turn.cancel", "the session did not complete a turn after a cancel")
        return
      }
      pass("turn.cancel")
    })
  }

  const approvalPrompt = options.approvalPrompt
  if (approvalPrompt === undefined) {
    for (const id of ["approval.allow", "approval.deny", "approval.unknown", "approval.cancel"])
      skip(id, "no approvalPrompt")
  } else {
    const decide = (id: string, approved: boolean) =>
      scenario([id], async (backend, session, deadline) => {
        const reader = new EventReader(() =>
          backend.send({ sessionId: session.id, message: approvalPrompt }),
        )
        const asked = await reader.readUntil(
          (event) => typeOf(event) === "approval.required",
          deadline,
        )
        if (asked !== "matched") {
          await reader.stop()
          fail(id, "the turn never asked for an approval")
          return
        }
        const approvalId = recordOf(reader.events.at(-1))?.approvalId
        if (typeof approvalId !== "string") {
          await reader.stop()
          fail(id, "approval.required carried no approvalId")
          return
        }
        if (backend.resolveApproval === undefined) {
          await reader.stop()
          fail(id, "the backend asks for approvals but has no resolveApproval")
          return
        }
        const accepted = await backend.resolveApproval(
          session.id,
          approvalId,
          approved,
          "conformance",
        )
        if (accepted === undefined) {
          await reader.stop()
          fail(id, "resolveApproval did not know the approval it asked for")
          return
        }
        const outcome = await reader.readToEnd(deadline)
        if (outcome !== "ended") {
          await reader.stop()
          fail(
            id,
            outcome === "timeout" ? "the turn did not end after the answer" : "the stream threw",
          )
          return
        }
        const problem = turnProblem(reader.events, session.id, true)
        // A host records the answer itself, so a backend need not echo it; one that does must agree.
        const contradicted = reader.events.some((event) => {
          const record = recordOf(event)
          return (
            record?.type === "approval.resolved" &&
            record.approvalId === approvalId &&
            record.approved !== approved
          )
        })
        if (problem !== undefined) fail(id, problem)
        else if (contradicted)
          fail(id, `approval.resolved for ${approvalId} contradicts the answer`)
        else pass(id)
      })
    await decide("approval.allow", true)
    await decide("approval.deny", false)

    await scenario(["approval.unknown"], async (backend, session) => {
      if (backend.resolveApproval === undefined) {
        skip("approval.unknown", "the backend has no resolveApproval")
        return
      }
      const answer = await backend.resolveApproval(session.id, "conformance-unknown-approval", true)
      if (answer !== undefined)
        fail(
          "approval.unknown",
          "an approval nobody asked for took a decision instead of undefined",
        )
      else pass("approval.unknown")
    })

    await scenario(["approval.cancel"], async (backend, session, deadline) => {
      const reader = new EventReader(() =>
        backend.send({ sessionId: session.id, message: approvalPrompt }),
      )
      if (
        (await reader.readUntil((event) => typeOf(event) === "approval.required", deadline)) !==
        "matched"
      ) {
        await reader.stop()
        fail("approval.cancel", "the turn never asked for an approval")
        return
      }
      const approvalId = recordOf(reader.events.at(-1))?.approvalId
      await backend.cancel(session.id, "conformance")
      if ((await reader.readToEnd(deadline)) !== "ended") {
        await reader.stop()
        fail("approval.cancel", "a turn waiting on an approval did not end after cancel")
        return
      }
      if (typeOf(reader.events.at(-1)) !== "session.stopped") {
        fail(
          "approval.cancel",
          `the cancelled turn ended with ${String(typeOf(reader.events.at(-1)))}`,
        )
        return
      }
      const late =
        typeof approvalId === "string"
          ? await backend.resolveApproval?.(session.id, approvalId, true)
          : undefined
      if (late !== undefined)
        fail("approval.cancel", "an approval stayed open after its turn was cancelled")
      else pass("approval.cancel")
    })
  }

  await scenario(["session.close"], async (backend, session, deadline) => {
    await backend.close(session.id)
    const reader = new EventReader(() =>
      backend.send({ sessionId: session.id, message: options.prompt }),
    )
    const outcome = await reader.readToEnd(deadline)
    if (outcome === "timeout") {
      await reader.stop()
      fail("session.close", "a message to a closed session neither failed nor ended")
    } else if (
      outcome === "threw" ||
      (reader.events.length > 0 &&
        reader.events.every((event) => typeOf(event) === "session.failed"))
    )
      pass("session.close")
    else fail("session.close", "a closed session ran a turn")
  })

  return { backend: backendName, ok: checks.every((check) => check.status !== "failed"), checks }
}
