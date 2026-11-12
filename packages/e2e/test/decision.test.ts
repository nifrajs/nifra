import { describe, expect, test } from "bun:test"
import { parseActDecision, parseExtraction, parseVerdict, targetSelector } from "../src/decision.ts"
import { forModel, forPage, redact, Secret } from "../src/params.ts"
import { pruneSnapshot } from "../src/snapshot.ts"

const refused = (raw: unknown): string => {
  const parsed = parseActDecision(raw)
  return parsed.ok ? "ok" : parsed.reason
}

describe("parseActDecision", () => {
  test("accepts each decision kind", () => {
    expect(parseActDecision({ kind: "done" })).toEqual({ ok: true, value: { kind: "done" } })
    expect(parseActDecision({ kind: "done", summary: "s" })).toEqual({
      ok: true,
      value: { kind: "done", summary: "s" },
    })
    expect(parseActDecision({ kind: "fail", reason: "r" })).toEqual({
      ok: true,
      value: { kind: "fail", reason: "r" },
    })
    expect(parseActDecision({ kind: "goto", path: "/x" })).toEqual({
      ok: true,
      value: { kind: "goto", path: "/x" },
    })
    expect(parseActDecision({ kind: "press", target: { label: "A" }, key: "Enter" })).toEqual({
      ok: true,
      value: { kind: "press", target: { label: "A" }, key: "Enter" },
    })
    expect(
      parseActDecision({
        kind: "tap",
        target: { role: "button", name: "Go", exact: true, nth: 1 },
      }),
    ).toEqual({
      ok: true,
      value: { kind: "tap", target: { role: "button", name: "Go", exact: true, nth: 1 } },
    })
  })

  test("refuses what is malformed", () => {
    expect(refused("tap")).toBe("a decision must be an object")
    expect(refused([])).toBe("a decision must be an object")
    expect(refused({ kind: "dance" })).toBe('unknown decision kind "dance"')
    expect(refused({ kind: "fail" })).toBe("fail needs a reason")
    expect(refused({ kind: "fail", reason: "" })).toBe("fail needs a reason")
    expect(refused({ kind: "goto", path: "x" })).toBe("goto needs a path that starts with /")
    expect(refused({ kind: "fill", target: { label: "A" } })).toBe("fill needs a string value")
    expect(refused({ kind: "press", target: { label: "A" } })).toBe("press needs a key")
    expect(refused({ kind: "tap" })).toBe("target must be an object")
    expect(refused({ kind: "tap", target: { role: "button", label: "A" } })).toBe(
      "target needs exactly one of role, label, text, testId",
    )
    expect(refused({ kind: "tap", target: { role: "" } })).toBe(
      "target.role must be a non-empty string",
    )
    expect(refused({ kind: "tap", target: { role: "button", exact: "yes" } })).toBe(
      "target.exact must be a boolean",
    )
    for (const nth of [-1, 1.5, "0"]) {
      expect(refused({ kind: "tap", target: { role: "button", nth } })).toBe(
        "target.nth must be a non-negative integer",
      )
    }
  })
})

describe("parseVerdict and parseExtraction", () => {
  test("verdicts", () => {
    expect(parseVerdict({ pass: true })).toEqual({ ok: true, value: { pass: true, reason: "" } })
    expect(parseVerdict({ pass: "inconclusive", reason: "r" })).toEqual({
      ok: true,
      value: { pass: "inconclusive", reason: "r" },
    })
    expect(parseVerdict(null).ok).toBe(false)
    expect(parseVerdict({ pass: "yes" }).ok).toBe(false)
  })

  test("extractions need a value key, even an undefined-looking one", () => {
    expect(parseExtraction({ value: 0 })).toEqual({ ok: true, value: 0 })
    expect(parseExtraction({ value: null })).toEqual({ ok: true, value: null })
    expect(parseExtraction({}).ok).toBe(false)
    expect(parseExtraction("x").ok).toBe(false)
  })
})

describe("targetSelector", () => {
  test("builds one finder step plus an optional nth", () => {
    expect(targetSelector({ role: "button", name: "Go", exact: true, nth: 2 })).toEqual([
      { kind: "role", role: "button", name: "Go", exact: true },
      { kind: "nth", index: 2 },
    ])
    expect(targetSelector({ role: "link" })).toEqual([{ kind: "role", role: "link" }])
    expect(targetSelector({ label: "Email", exact: false })).toEqual([
      { kind: "label", text: "Email", exact: false },
    ])
    expect(targetSelector({ text: "Hi" })).toEqual([{ kind: "text", text: "Hi" }])
    expect(targetSelector({ testId: "x" })).toEqual([{ kind: "testId", id: "x" }])
  })
})

describe("Secret and params", () => {
  const params = { name: "Ada", n: 3, on: true, pw: new Secret("pw", "hunter2") }

  test("a secret prints its name and nothing else", () => {
    const secret = new Secret("pw", "hunter2")
    expect(String(secret)).toBe("[secret:pw]")
    expect(`${secret}`).toBe("[secret:pw]")
    expect(JSON.stringify({ secret })).toBe('{"secret":"[secret:pw]"}')
    expect(Secret.reveal(secret)).toBe("hunter2")
  })

  test("forModel fills plain params and keeps secrets as placeholders", () => {
    expect(forModel("hi {name} {n} {on} {pw} {pw} {missing}", params)).toEqual({
      text: "hi Ada 3 true {pw} {pw} {missing}",
      secrets: ["pw"],
    })
  })

  test("forPage fills everything, redact takes secrets back out", () => {
    expect(forPage("{name}/{pw}/{missing}", params)).toBe("Ada/hunter2/{missing}")
    expect(redact("echo hunter2 and hunter2", params)).toBe("echo {pw} and {pw}")
    expect(redact("nothing", { pw: new Secret("pw", "") })).toBe("nothing")
  })
})

describe("pruneSnapshot", () => {
  test("a snapshot that fits comes back as is, long lines shortened", () => {
    expect(pruneSnapshot("- a\n- b", 100)).toBe("- a\n- b")
    expect(pruneSnapshot(`- ${"x".repeat(50)}`, 1000, 10)).toBe("- xxxxxxx…")
  })

  test("over the limit, controls and headings win and gaps are marked", () => {
    const lines = [
      "- text: one",
      "- text: two",
      '- button "Go"',
      "- text: three",
      '- heading "H"',
      "- text: four",
    ]
    const pruned = pruneSnapshot(lines.join("\n"), 40)
    expect(pruned).toBe(
      [
        "- text: one",
        "  … (1 lines omitted)",
        '- button "Go"',
        "  … (1 lines omitted)",
        '- heading "H"',
        "  … (1 lines omitted)",
      ].join("\n"),
    )
  })

  test("leftover room is filled in page order", () => {
    const lines = ["- text: aaaa", '- button "B"', "- text: cccc"]
    expect(pruneSnapshot(lines.join("\n"), 38)).toBe(
      ["- text: aaaa", '- button "B"', "  … (1 lines omitted)"].join("\n"),
    )
  })
})
