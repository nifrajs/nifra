import { describe, expect, test } from "bun:test"
import { parseArtifactRef, parseRunEvidence, parseRunPlan, RunContractError } from "../src/index.ts"

const DIGEST = "a".repeat(64)
const plan = (nodes: unknown[], extra: Record<string, unknown> = {}) => ({
  version: 1,
  id: "plan",
  nodes,
  ...extra,
})
const task = (extra: Record<string, unknown> = {}) => ({
  id: "t",
  kind: "task",
  step: "s",
  ...extra,
})

describe("run plan contract refusals", () => {
  test("names the field a plan gets wrong", () => {
    const cases: [unknown, string][] = [
      [plan([task()], { version: 2 }), "run plan.version must be 1"],
      [plan([]), "run plan.nodes must be a non-empty array"],
      [plan([{ id: "x", kind: "loop" }]), "node[0].kind 'loop' is invalid"],
      [
        plan([{ id: "s", kind: "sequence", children: [] }]),
        "node[0].children must be a non-empty array",
      ],
      [plan([task({ dependsOn: "a" })]), "node[0].dependsOn must be a string array"],
      [plan([task({ id: "" })]), "node[0].id must be a non-empty string"],
      [plan([task({ reason: 5 })]), "node[0].reason must be a string"],
      [plan([task({ stepVersion: 0 })]), "node[0].stepVersion must be a positive integer"],
      [plan([task({ retry: "twice" })]), "node[0].retry must be an object"],
      [plan([task({ retry: { attempts: 17 } })]), "node[0].retry.attempts must be 1..16"],
      [
        plan([task({ retry: { attempts: 2, backoffMs: -1 } })]),
        "node[0].retry.backoffMs must be a non-negative integer",
      ],
    ]
    for (const [value, message] of cases)
      expect(() => parseRunPlan(value)).toThrow(new RunContractError(message))
  })

  test("a leaf keeps its retry policy; an uncapped parallel and a one-armed branch stay so", () => {
    const parsed = parseRunPlan(
      plan([
        task({ retry: { attempts: 2, backoffMs: 10 } }),
        {
          id: "p",
          kind: "parallel",
          children: [task({ id: "c", retry: { attempts: 3 } })],
        },
      ]),
    )
    expect(parsed.nodes[0]).toEqual({
      id: "t",
      kind: "task",
      step: "s",
      retry: { attempts: 2, backoffMs: 10 },
    })
    expect(parsed.nodes[1]).toEqual({
      id: "p",
      kind: "parallel",
      children: [{ id: "c", kind: "task", step: "s", retry: { attempts: 3 } }],
    })
    // biome-ignore lint/suspicious/noThenProperty: RunPlan branch nodes name their arms then/otherwise.
    const branch = { id: "b", kind: "branch", step: "gate", then: task({ id: "yes" }) }
    expect(parseRunPlan(plan([branch])).nodes[0]).not.toHaveProperty("otherwise")
  })
})

describe("artifact and evidence refusals", () => {
  const ref = { id: "a", digest: DIGEST, bytes: 1, mediaType: "text/plain" }
  const evidence = {
    version: 1,
    runId: "r",
    planDigest: DIGEST,
    nodeId: "n",
    status: "completed",
    seq: 0,
    idempotent: false,
  }

  test("an artifact ref keeps a string locator and refuses any other", () => {
    expect(parseArtifactRef({ ...ref, locator: "s3://bucket/a" })).toEqual({
      ...ref,
      locator: "s3://bucket/a",
    })
    expect(() => parseArtifactRef({ ...ref, locator: 5 })).toThrow(
      "artifact ref.locator must be a string",
    )
    expect(() => parseArtifactRef({ ...ref, bytes: -1 })).toThrow(
      "artifact ref.bytes must be a non-negative integer",
    )
  })

  test("evidence refuses a version, status, flag or key outside its contract", () => {
    const cases: [unknown, string][] = [
      [{ ...evidence, version: 2 }, "evidence.version must be 1"],
      [{ ...evidence, status: "paused" }, "evidence.status is invalid"],
      [{ ...evidence, idempotent: "no" }, "evidence.idempotent must be a boolean"],
      [{ ...evidence, effectKey: "abc" }, "evidence.effectKey must be sha256 hex"],
    ]
    for (const [value, message] of cases)
      expect(() => parseRunEvidence(value)).toThrow(new RunContractError(message))
  })
})
