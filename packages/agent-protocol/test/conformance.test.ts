import { describe, expect, test } from "bun:test"
import { checkAgentBackend } from "../src/conformance.ts"
import type {
  AgentBackend,
  AgentEvent,
  AgentSessionSnapshot,
  AgentSessionStatus,
  CreateSessionInput,
  SendMessageInput,
} from "../src/index.ts"

type Flaw =
  | "acceptsUnknown"
  | "answerHangs"
  | "badSeq"
  | "busyAccepted"
  | "busyEndsFirst"
  | "cancelCompletes"
  | "cancelIgnored"
  | "closedHangs"
  | "contradicts"
  | "deadAfterCancel"
  | "endsFailed"
  | "eventAfterEnd"
  | "forgetsApproval"
  | "invalidEvent"
  | "keepsApproval"
  | "neverAsks"
  | "neverEnds"
  | "noResolve"
  | "noTerminal"
  | "noTurnStarted"
  | "otherSession"
  | "otherTurn"
  | "runsWhenClosed"
  | "sendThrows"
  | "snapshotOther"
  | "startsRunning"
  | "stillRunning"
  | "streamThrows"
  | "twoTurns"
  | "wrongCwd"

interface Pending {
  readonly id: string
  readonly answer: PromiseWithResolvers<boolean>
}

/** A backend that keeps the protocol unless a flaw says otherwise. */
class FakeBackend implements AgentBackend {
  readonly info = { name: "fake", capabilities: [] }
  readonly resolveApproval?: NonNullable<AgentBackend["resolveApproval"]>
  private readonly id = "fake-session"
  private cwd = ""
  private seq = 0
  private status: AgentSessionStatus = "idle"
  private readonly runs = new Set<PromiseWithResolvers<void>>()
  private pending: Pending | undefined
  private closed = false
  private dead = false

  constructor(private readonly flaws: ReadonlySet<Flaw>) {
    if (!flaws.has("noResolve"))
      this.resolveApproval = async (_sessionId, approvalId, approved) => {
        if (flaws.has("forgetsApproval")) return undefined
        const pending = this.pending
        if (pending?.id !== approvalId) return flaws.has("acceptsUnknown") ? approved : undefined
        pending.answer.resolve(approved)
        return approved
      }
  }

  async createSession(input: CreateSessionInput): Promise<AgentSessionSnapshot> {
    this.cwd = this.flaws.has("wrongCwd") ? "/elsewhere" : input.cwd
    if (this.flaws.has("startsRunning")) this.status = "running"
    return this.view()
  }

  send(input: SendMessageInput): AsyncIterable<AgentEvent> {
    if (this.flaws.has("sendThrows")) throw new Error("send exploded")
    return this.turn(input.message)
  }

  async cancel(): Promise<void> {
    if (this.flaws.has("cancelIgnored")) return
    if (this.flaws.has("deadAfterCancel")) this.dead = true
    for (const run of this.runs) run.resolve()
  }

  async snapshot(): Promise<AgentSessionSnapshot> {
    const view = this.view()
    return this.flaws.has("snapshotOther") ? { ...view, id: "another" } : view
  }

  async reload() {
    return { revision: "1", loaded: [], disabled: [], rolledBack: false }
  }

  async close(): Promise<void> {
    this.closed = true
    for (const run of this.runs) run.resolve()
  }

  private view(): AgentSessionSnapshot {
    return {
      version: 1,
      id: this.id,
      backend: "fake",
      cwd: this.cwd,
      status: this.status,
      createdAt: 0,
      updatedAt: 0,
      lastSeq: Math.max(0, this.seq - 1),
      capabilities: [],
    }
  }

  private envelope(sessionId = this.id) {
    return { version: 1, sessionId, seq: this.seq++, at: 0 } as const
  }

  private failed(code: string): AgentEvent {
    const error = { code, message: code }
    return { ...this.envelope(), type: "session.failed", error, recoverable: true }
  }

  private async *turn(message: string): AsyncGenerator<AgentEvent> {
    if (this.closed && !this.flaws.has("runsWhenClosed")) {
      if (this.flaws.has("closedHangs")) await new Promise(() => {})
      yield this.failed("closed")
      return
    }
    if (this.runs.size > 0 && !this.flaws.has("busyAccepted")) {
      if (this.flaws.has("busyEndsFirst")) this.status = "idle"
      yield this.failed("busy")
      return
    }
    const cancel = Promise.withResolvers<void>()
    this.runs.add(cancel)
    this.status = "running"
    try {
      yield* this.steps(message, cancel.promise)
    } finally {
      this.runs.delete(cancel)
      if (!this.flaws.has("stillRunning")) this.status = "idle"
    }
  }

  private async *steps(message: string, cancelled: Promise<void>): AsyncGenerator<AgentEvent> {
    const turnId = "t1"
    // Only the plain prompt skips it; the others wait for turn.started before going on.
    if (!this.flaws.has("noTurnStarted") || message !== "hello")
      yield { ...this.envelope(), type: "turn.started", turnId, prompt: message }
    if (message === "slow") {
      await cancelled
      yield this.flaws.has("cancelCompletes")
        ? { ...this.envelope(), type: "session.completed", snapshot: this.view() }
        : { ...this.envelope(), type: "session.stopped", reason: "cancelled" }
      return
    }
    if (message === "approve" && !this.flaws.has("neverAsks")) {
      const pending: Pending = { id: "a1", answer: Promise.withResolvers<boolean>() }
      this.pending = pending
      yield {
        ...this.envelope(),
        type: "approval.required",
        turnId,
        approvalId: pending.id,
        action: "write a.txt",
        capability: "filesystem.write",
      }
      const approved = await Promise.race([pending.answer.promise, cancelled.then(() => undefined)])
      if (!this.flaws.has("keepsApproval")) this.pending = undefined
      if (approved === undefined) {
        yield { ...this.envelope(), type: "session.stopped", reason: "cancelled" }
        return
      }
      if (this.flaws.has("answerHangs")) await cancelled
      const echoed = this.flaws.has("contradicts") ? !approved : approved
      yield {
        ...this.envelope(),
        type: "approval.resolved",
        approvalId: pending.id,
        approved: echoed,
      }
    }
    if (this.flaws.has("neverEnds")) await new Promise(() => {})
    if (this.flaws.has("streamThrows")) throw new Error("stream exploded")
    if (this.dead) {
      yield this.failed("dead")
      return
    }
    yield* this.reply(turnId)
  }

  private async *reply(turnId: string): AsyncGenerator<AgentEvent> {
    const flaws = this.flaws
    if (flaws.has("badSeq")) this.seq--
    const sessionId = flaws.has("otherSession") ? "another" : this.id
    const text = flaws.has("invalidEvent") ? "x".repeat(300_000) : "done"
    const replyTurn = flaws.has("otherTurn") ? "t2" : turnId
    yield { ...this.envelope(sessionId), type: "assistant.message", turnId: replyTurn, text }
    if (flaws.has("twoTurns"))
      yield { ...this.envelope(), type: "turn.started", turnId: "t2", prompt: "" }
    if (flaws.has("noTerminal")) return
    yield flaws.has("endsFailed")
      ? this.failed("model")
      : { ...this.envelope(), type: "session.completed", snapshot: this.view() }
    if (flaws.has("eventAfterEnd"))
      yield { ...this.envelope(), type: "assistant.delta", turnId, text: "late" }
  }
}

function run(flaws: readonly Flaw[] = [], timeoutMs?: number) {
  return checkAgentBackend({
    backend: () => new FakeBackend(new Set(flaws)),
    cwd: "/work",
    prompt: "hello",
    slowPrompt: "slow",
    approvalPrompt: "approve",
    timeoutMs: timeoutMs ?? 5_000,
  })
}

async function failures(flaws: readonly Flaw[], timeoutMs?: number) {
  const report = await run(flaws, timeoutMs)
  expect(report.ok).toBe(false)
  return report.checks
    .filter((check) => check.status === "failed")
    .map((check) => `${check.id}: ${check.detail}`)
}

describe("checkAgentBackend", () => {
  test("a backend that keeps the protocol passes every check", async () => {
    const report = await run()
    expect(report.backend).toBe("fake")
    expect(report.ok).toBe(true)
    expect(report.checks.map((check) => `${check.id} ${check.status}`)).toEqual([
      "session.create passed",
      "turn.events passed",
      "turn.completes passed",
      "turn.snapshot passed",
      "turn.busy passed",
      "turn.cancel passed",
      "approval.allow passed",
      "approval.deny passed",
      "approval.unknown passed",
      "approval.cancel passed",
      "session.close passed",
    ])
  })

  test("skips what the options do not enable and refuses a bad timeout", async () => {
    const report = await checkAgentBackend({
      backend: () => new FakeBackend(new Set()),
      cwd: "/work",
      prompt: "hello",
    })
    expect(report.ok).toBe(true)
    expect(
      report.checks.filter((check) => check.status === "skipped").map((check) => check.id),
    ).toEqual([
      "turn.busy",
      "turn.cancel",
      "approval.allow",
      "approval.deny",
      "approval.unknown",
      "approval.cancel",
    ])
    await expect(run([], 0)).rejects.toThrow("timeoutMs must be a positive integer")
  })

  test.each<[Flaw, string]>([
    ["wrongCwd", "session.create: snapshot.cwd is not the cwd asked for"],
    ["startsRunning", "session.create: a new session is already running"],
    ["badSeq", "turn.events: event 1 has seq 0 after 0"],
    ["otherSession", "turn.events: event 1 names another session"],
    ["noTurnStarted", "turn.events: event 0 (assistant.message) comes before turn.started"],
    ["otherTurn", "turn.events: event 1 (assistant.message) names another turn"],
    ["twoTurns", "turn.events: event 2 starts a second turn"],
    [
      "eventAfterEnd",
      "turn.events: event 2 (session.completed) ends the turn but more events follow",
    ],
    [
      "noTerminal",
      "turn.events: the stream ended without session.completed, session.failed, or session.stopped",
    ],
    ["endsFailed", "turn.completes: the turn ended with session.failed, not session.completed"],
    ["stillRunning", "turn.snapshot: the session is still running after its turn"],
    ["snapshotOther", "turn.snapshot: snapshot names another session"],
    [
      "busyAccepted",
      "turn.busy: a second message while a turn runs was not refused on its own stream",
    ],
    ["busyEndsFirst", "turn.busy: refusing the second message ended the running turn"],
    ["cancelCompletes", "turn.cancel: a cancelled turn ended with session.completed"],
    ["deadAfterCancel", "turn.cancel: the session did not complete a turn after a cancel"],
    ["neverAsks", "approval.allow: the turn never asked for an approval"],
    ["noResolve", "approval.allow: the backend asks for approvals but has no resolveApproval"],
    ["forgetsApproval", "approval.deny: resolveApproval did not know the approval it asked for"],
    ["contradicts", "approval.allow: approval.resolved for a1 contradicts the answer"],
    [
      "acceptsUnknown",
      "approval.unknown: an approval nobody asked for took a decision instead of undefined",
    ],
    ["keepsApproval", "approval.cancel: an approval stayed open after its turn was cancelled"],
    ["runsWhenClosed", "session.close: a closed session ran a turn"],
    ["sendThrows", "turn.events: the stream threw: send exploded"],
    ["streamThrows", "turn.completes: the stream threw"],
  ])("reports a backend with the %s flaw", async (flaw, expected) => {
    expect(await failures([flaw])).toContain(expected)
  })

  test("the first check names the event that breaks the bounds", async () => {
    const found = await failures(["invalidEvent"])
    expect(found[0]).toStartWith("turn.events: event 1: assistant.message.text")
  })

  test.each<[Flaw, string]>([
    ["neverEnds", "turn.events: the turn did not end within 50 ms"],
    ["cancelIgnored", "turn.cancel: the turn did not end within 50 ms of cancel"],
    ["answerHangs", "approval.allow: the turn did not end after the answer"],
    ["closedHangs", "session.close: a message to a closed session neither failed nor ended"],
  ])("reports a backend with the %s flaw by its deadline", async (flaw, expected) => {
    expect(await failures([flaw], 50)).toContain(expected)
  })

  test("a backend that cannot be built fails every check of its scenario", async () => {
    const report = await checkAgentBackend({
      backend: () => {
        throw new Error("no binary")
      },
      cwd: "/work",
      prompt: "hello",
    })
    expect(report.backend).toBe("unknown")
    expect(report.checks.find((check) => check.id === "turn.events")).toEqual({
      id: "turn.events",
      status: "failed",
      detail: "the scenario threw: no binary",
    })
  })
})
