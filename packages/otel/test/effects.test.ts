import { describe, expect, test } from "bun:test"
import { executeCapability } from "@nifrajs/core/capabilities"
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
})
