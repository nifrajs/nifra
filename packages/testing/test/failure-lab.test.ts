import { describe, expect, test } from "bun:test"
import { createFailureLab, FailureInjectedError, runFailureScenario } from "../src/failure-lab.ts"

describe("deterministic failure laboratory", () => {
  test("duplicates and reorders deliveries reproducibly without recording payloads", () => {
    const options = {
      seed: 77,
      schedule: [
        { kind: "duplicate-delivery" as const, point: "relay.batch", copies: 3 },
        { kind: "reorder-events" as const, point: "relay.batch" },
      ],
    }
    const first = createFailureLab(options)
    const second = createFailureLab(options)
    const a = first.deliveries("relay.batch", ["evt-a", "evt-b", "evt-c"])
    const b = second.deliveries("relay.batch", ["evt-a", "evt-b", "evt-c"])

    expect(a).toEqual(b)
    expect(a).toHaveLength(9)
    expect(a.filter((value) => value === "evt-a")).toHaveLength(3)
    expect(first.evidence()).toEqual([
      {
        sequence: 1,
        kind: "duplicate-delivery",
        point: "relay.batch",
        occurrence: 1,
        virtualTimeMs: 0,
      },
      {
        sequence: 2,
        kind: "reorder-events",
        point: "relay.batch",
        occurrence: 1,
        virtualTimeMs: 0,
      },
    ])
    expect(JSON.stringify(first.evidence())).not.toContain("evt-a")
  })

  test("proves crash-after-commit behavior with replayable, token-only evidence", async () => {
    let commits = 0
    let dispatches = 0
    const report = await runFailureScenario(
      {
        name: "outbox-crash-after-commit",
        async execute(lab) {
          commits += 1
          lab.checkpoint("outbox.after_commit")
          dispatches += 1
        },
        verify({ error }) {
          return (
            error instanceof FailureInjectedError &&
            error.kind === "crash" &&
            commits === 1 &&
            dispatches === 0
          )
        },
      },
      { seed: 9, schedule: [{ kind: "crash", point: "outbox.after_commit" }] },
    )

    expect(report.ok).toBe(true)
    expect(report.error).toEqual({ name: "FailureInjectedError", kind: "crash" })
    expect(report.replay.seed).toBe(9)
    expect(report.replay.schedule).toEqual([
      { kind: "crash", point: "outbox.after_commit", occurrence: 1 },
    ])
    expect(JSON.stringify(report)).not.toContain("stack")
  })

  test("loses a provider reply only after the provider operation completed", async () => {
    let charges = 0
    const lab = createFailureLab({
      seed: 1,
      schedule: [{ kind: "lose-provider-reply", point: "billing.charge" }],
    })

    await expect(
      lab.provider("billing.charge", async () => {
        charges += 1
        return { providerSecret: "must-not-enter-evidence" }
      }),
    ).rejects.toMatchObject({ kind: "lose-provider-reply" })
    expect(charges).toBe(1)
    expect(JSON.stringify(lab.evidence())).not.toContain("providerSecret")
  })

  test("models virtual delay, budget expiry, and one checkpoint contention without sleeping", () => {
    const lab = createFailureLab({
      seed: 5,
      startTimeMs: 100,
      schedule: [
        { kind: "delay", point: "retry.before", delayMs: 250 },
        { kind: "expire-budget", point: "retry.budget" },
        { kind: "contend-checkpoint", point: "projection.commit" },
      ],
    })

    lab.checkpoint("retry.before")
    expect(lab.now()).toBe(350)
    expect(lab.remaining("retry.budget", 500)).toBe(0)
    expect(lab.checkpointContended("projection.commit")).toBe(true)
    expect(lab.checkpointContended("projection.commit")).toBe(false)
  })

  test("rejects ambiguous or unbounded schedules at construction", () => {
    expect(() =>
      createFailureLab({
        schedule: [
          { kind: "crash", point: "same", occurrence: 1 },
          { kind: "crash", point: "same", occurrence: 1 },
        ],
      }),
    ).toThrow(/duplicate directive/)
    expect(() =>
      createFailureLab({
        schedule: [{ kind: "delay", point: "bad point", delayMs: 1 }],
      }),
    ).toThrow(/invalid failure point/)
    expect(() =>
      createFailureLab({
        schedule: [{ kind: "duplicate-delivery", point: "relay", copies: 100 }],
      }),
    ).toThrow(/copies/)
  })
})
