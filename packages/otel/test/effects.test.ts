import { describe, expect, test } from "bun:test"
import { executeCapability } from "@nifrajs/core/capabilities"
import { effectLedger } from "@nifrajs/core/effect-ledger"
import { server } from "@nifrajs/core/server"
import { effectTracing } from "../src/effects.ts"
import type { NifraSpan, ObservationAdapter } from "../src/span.ts"

describe("effectTracing", () => {
  test("exports admission and execution spans keyed by effectId without payload or error text", async () => {
    const spans: NifraSpan[] = []
    const exporter: ObservationAdapter = { onEnd: (span) => spans.push(span) }
    const effects = effectTracing({ exporter })
    const app = server()
      .use(effects)
      .aroundCapability(async (_event, next) => next())
      .post("/charge", { capabilities: ["payments.charge"] }, async (c) => {
        await executeCapability(
          c,
          "payments.charge",
          { target: "provider:stripe", digest: "a".repeat(64), cost: { calls: 1 } },
          async () => ({ cardNumber: "4111111111111111" }),
        )
        return { ok: true }
      })

    expect(
      (await app.fetch(new Request("http://nifra.test/charge", { method: "POST" }))).status,
    ).toBe(200)
    expect(spans).toHaveLength(2)
    expect(spans.map((span) => span.name)).toEqual([
      "nifra.effect.admission",
      "nifra.effect.execution",
    ])
    expect(spans[0]?.attributes["nifra.effect.id"]).toBe(spans[1]?.attributes["nifra.effect.id"])
    expect(spans[1]?.attributes).toMatchObject({
      "nifra.effect.capability": "payments.charge",
      "nifra.effect.stage": "execution",
      "nifra.effect.phase": "succeeded",
      "nifra.effect.target": "provider:stripe",
      "nifra.effect.cost.calls": 1,
    })
    const exported = JSON.stringify(spans)
    expect(exported).not.toContain("4111111111111111")
    expect(exported).not.toContain("cardNumber")
  })

  test("failure exports only a bounded error code", async () => {
    const spans: NifraSpan[] = []
    const app = server({ logger: { debug() {}, info() {}, warn() {}, error() {} } })
      .use(effectTracing({ exporter: { onEnd: (span) => spans.push(span) } }))
      .post("/charge", { capabilities: ["payments.charge"] }, async (c) => {
        await executeCapability(c, "payments.charge", {}, async () => {
          throw new Error("private customer secret")
        })
      })

    expect(
      (await app.fetch(new Request("http://nifra.test/charge", { method: "POST" }))).status,
    ).toBe(500)
    expect(JSON.stringify(spans)).not.toContain("private customer secret")
    expect(spans.at(-1)?.attributes["nifra.effect.error_code"]).toBe("execution_failed")
  })

  test("terminal ledger failure still completes the successful effect span", async () => {
    const spans: NifraSpan[] = []
    const app = server({ logger: { debug() {}, info() {}, warn() {}, error() {} } })
      .use(effectTracing({ exporter: { onEnd: (span) => spans.push(span) } }))
      .use(effectLedger({ sink() {}, maxEntries: 1 }))
      .post("/charge", { capabilities: ["payments.charge"] }, async (c) => {
        await executeCapability(c, "payments.charge", {}, async () => undefined)
        return { ok: true }
      })

    expect(
      (await app.fetch(new Request("http://nifra.test/charge", { method: "POST" }))).status,
    ).toBe(500)
    expect(spans.map((span) => span.name)).toEqual([
      "nifra.effect.admission",
      "nifra.effect.execution",
    ])
    expect(spans.at(-1)?.status).toBe("ok")
  })

  test("active effect observations are bounded when terminal events never arrive", () => {
    const spans: NifraSpan[] = []
    const effects = effectTracing({
      exporter: { onEnd: (span) => spans.push(span) },
      maxActive: 2,
    })
    for (const effectId of ["effect_1", "effect_2", "effect_3"]) {
      effects.observer({
        effectId,
        capability: "payments.charge",
        stage: "execution",
        phase: "started",
        at: 1,
      })
    }

    expect(spans).toHaveLength(1)
    expect(spans[0]?.attributes["nifra.effect.id"]).toBe("effect_1")
    expect(spans[0]?.attributes["nifra.effect.error_code"]).toBe("observation_evicted")
    expect(spans[0]?.status).toBe("error")
  })

  test("stale unmatched effect observations expire on the next lifecycle event", () => {
    const spans: NifraSpan[] = []
    let now = 10
    const effects = effectTracing({
      exporter: { onEnd: (span) => spans.push(span) },
      maxActiveAgeMs: 5,
      now: () => now,
    })
    effects.observer({
      effectId: "effect_old",
      capability: "db.write",
      stage: "execution",
      phase: "started",
      at: 10,
    })
    now = 15
    effects.observer({
      effectId: "effect_new",
      capability: "db.write",
      stage: "execution",
      phase: "started",
      at: 15,
    })

    expect(spans).toHaveLength(1)
    expect(spans[0]?.attributes["nifra.effect.id"]).toBe("effect_old")
    expect(spans[0]?.attributes["nifra.effect.error_code"]).toBe("observation_expired")
  })
})
