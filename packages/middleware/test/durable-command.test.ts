import { describe, expect, test } from "bun:test"
import { server } from "@nifrajs/core"
import {
  type CapabilityExecutionJournal,
  evaluateCapabilityAssurance,
  executeCapability,
} from "@nifrajs/core/capabilities"
import {
  createDurableEffectJournal,
  MemoryDurableEffectStore,
} from "@nifrajs/core/durable-execution"
import { MemoryIdempotencyStore } from "@nifrajs/core/idempotency"
import { idempotency } from "@nifrajs/core/idempotency-plugin"
import { durableCommand } from "@nifrajs/middleware"

/**
 * `idempotency: "durable"` requires `nifra.durable-command` evidence, and nothing in the framework
 * produced it. The tier was reachable - a route could write `assurance: ["nifra.durable-command"]` -
 * but only by asserting it, which is wrong in both directions: journal your effects and forget the
 * string and `nifra check` fails a correct route; write the string and journal nothing and it passes
 * an incorrect one. Every other assurance id has a shipped emitter. This one now does too.
 *
 * So these tests check the two halves TOGETHER. An adapter that cleared the finding without recording
 * anything would be the bug wearing a badge, and half these tests would still pass.
 */

const DEFINITIONS = [
  {
    id: "billing.charge",
    zone: "domain" as const,
    access: "write" as const,
    idempotency: "durable" as const,
  },
]
const EVIDENCE = {
  routes: [
    {
      method: "POST",
      path: "/charge",
      covered: true,
      evidence: [{ id: "billing.charge", kind: "static" as const, source: "billing" }],
    },
  ],
}

const findingsFor = (app: unknown): string[] =>
  evaluateCapabilityAssurance(
    app as never,
    { definitions: DEFINITIONS, provenance: { imports: [], forbiddenImports: [] } },
    EVIDENCE,
  ).findings.map((finding) => finding.code)

/** A real durable journal (memory-backed for the test) that also records the transition order. */
const recordingJournal = (): { journal: CapabilityExecutionJournal; seen: string[] } => {
  const seen: string[] = []
  const inner = createDurableEffectJournal({
    store: new MemoryDurableEffectStore(),
    allowMemoryStore: true,
  })
  return {
    seen,
    journal: {
      intent: (input) => {
        seen.push("intent")
        return inner.intent(input)
      },
      executing: (id) => {
        seen.push("executing")
        return inner.executing(id)
      },
      committed: (id) => {
        seen.push("committed")
        return inner.committed(id)
      },
      failed: (id, input) => {
        seen.push("failed")
        return inner.failed(id, input)
      },
    },
  }
}

describe("durableCommand", () => {
  test("without it, a durable capability cannot be satisfied except by asserting it", () => {
    const bare = server().post("/charge", { capabilities: ["billing.charge"] }, () => ({
      ok: true,
    }))
    expect(findingsFor(bare)).toEqual(["missing-durable-idempotency"])

    // The pre-existing escape hatch, which is exactly the problem: a string, backed by nothing.
    const asserted = server().post(
      "/charge",
      { capabilities: ["billing.charge"], assurance: ["nifra.durable-command"] },
      () => ({ ok: true }),
    )
    expect(findingsFor(asserted)).toEqual([])
  })

  test("installing it satisfies the tier AND journals the effect", async () => {
    const { journal, seen } = recordingJournal()
    const app = server()
      .use(durableCommand({ journal }))
      .post("/charge", { capabilities: ["billing.charge"] }, (c: object) =>
        executeCapability(c, "billing.charge", {}, () => ({ ok: true })),
      )

    expect(findingsFor(app)).toEqual([])

    const res = await app.fetch(new Request("http://x/charge", { method: "POST" }))
    expect(res.status).toBe(200)
    // The evidence is a by-product of the journal running, not a claim beside it.
    expect(seen).toEqual(["intent", "executing", "committed"])
  })

  test("a failed effect records a terminal failure, not a silent gap", async () => {
    const { journal, seen } = recordingJournal()
    const app = server()
      .use(durableCommand({ journal }))
      .post("/charge", { capabilities: ["billing.charge"] }, (c: object) =>
        executeCapability(c, "billing.charge", {}, () => {
          throw new Error("gateway declined")
        }),
      )
    await app.fetch(new Request("http://x/charge", { method: "POST" }))
    expect(seen).toEqual(["intent", "executing", "failed"])
  })

  test("an explicitly passed journal still wins, so existing call sites are untouched", async () => {
    const installed = recordingJournal()
    const explicit = recordingJournal()
    const app = server()
      .use(durableCommand({ journal: installed.journal }))
      .post("/charge", { capabilities: ["billing.charge"] }, (c: object) =>
        executeCapability(c, "billing.charge", { journal: explicit.journal }, () => ({ ok: true })),
      )
    await app.fetch(new Request("http://x/charge", { method: "POST" }))
    expect(explicit.seen).toEqual(["intent", "executing", "committed"])
    expect(installed.seen).toEqual([])
  })

  test("it is order-scoped: a route registered before it is neither covered nor journaled", async () => {
    const { journal, seen } = recordingJournal()
    const app = server()
      .post("/charge", { capabilities: ["billing.charge"] }, (c: object) =>
        executeCapability(c, "billing.charge", {}, () => ({ ok: true })),
      )
      .use(durableCommand({ journal }))

    // `subsequent` scope, and the route came first - so the finding stands rather than being
    // cleared by a plugin that never runs for it.
    expect(findingsFor(app)).toEqual(["missing-durable-idempotency"])
    await app.fetch(new Request("http://x/charge", { method: "POST" }))
    expect(seen).toEqual([])
  })

  test("a journal missing a transition is refused at wiring time", () => {
    // Otherwise the miss surfaces as a TypeError partway through a production effect, on a route
    // whose evidence has already been declared and checked.
    expect(() => durableCommand({ journal: {} as never })).toThrow(/journal\.intent/)
    expect(() =>
      durableCommand({ journal: { intent() {}, executing() {}, committed() {} } as never }),
    ).toThrow(/journal\.failed/)
    expect(() => durableCommand({ journal: null as never })).toThrow(
      /must be a CapabilityExecutionJournal/,
    )
  })

  test("response replay is still not durable-command evidence", () => {
    // Pinned because this change is adjacent to it: `schema.idempotency` replays a stored response,
    // which does not make an effect exactly-once - a crash between the charge and the store leaves
    // nothing to replay. Only the journal survives that, so only the journal clears this tier.
    const durableStore = Object.assign(new MemoryIdempotencyStore(), {
      durability: "durable" as const,
    })
    const app = server()
      .use(idempotency())
      .post(
        "/charge",
        {
          capabilities: ["billing.charge"],
          idempotency: { scope: "durable", namespace: "public:charge", store: durableStore },
        },
        () => ({ ok: true }),
      )
    expect(findingsFor(app)).toEqual(["missing-durable-idempotency"])
  })
})
