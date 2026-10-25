import { expect, test } from "bun:test"
import { defineAgentEvalSuite } from "../src/agent-eval.ts"
import {
  type AdapterCertificationReport,
  verifyAdapterCertification,
} from "../src/certification.ts"

// Eval digests are compared against stored baselines and certification reports are re-verified after
// storage, so their bytes are pinned literally.
test("an eval suite digest is pinned", async () => {
  const suite = defineAgentEvalSuite({
    id: "golden",
    rubrics: [
      {
        id: "invariant",
        outcomes: ["fail", "pass"],
        score: { min: 0, max: 1 },
        metrics: ["latency"],
      },
    ],
    cases: [
      {
        id: "case",
        evaluate: () => [
          { rubricId: "invariant", outcome: "pass", score: 0.5, metrics: { latency: 12.5 } },
        ],
      },
    ],
  })
  expect((await suite.run()).digest).toBe(
    "16068b63a0ce47f613fba3ab16fcb30c5f49148d73542356148f0282bac5571f",
  )
})

test("a stored certification report with a pinned hash still verifies", async () => {
  const report: AdapterCertificationReport = {
    schemaVersion: 1,
    ok: false,
    profile: { id: "golden", version: 2 },
    adapterId: "memory",
    checks: [
      { id: "b.check", capability: "store.write", ok: true },
      { id: "a.check", capability: "store.read", ok: false, errorName: "TypeError" },
    ],
    capabilities: [
      { capability: "store.read", status: "failed", checks: ["a.check"] },
      { capability: "store.write", status: "passed", checks: ["b.check"] },
    ],
    evidenceHash: "fe5cf8dbc1d30ec5b9ff48a98aa9be8830de6e97448ce8e0188742379c660023",
  }
  expect(await verifyAdapterCertification(report)).toBe(true)
})
