import { expect, test } from "bun:test"
import { LEARN_PATH, renderLearnResult } from "../src/learn.ts"

test("no step renders the index with every step and a drill-in pointer", () => {
  const index = renderLearnResult()
  expect(index).toContain(`${LEARN_PATH.length} steps`)
  expect(index).toContain("nifra_learn with step: N")
  for (const step of LEARN_PATH) expect(index).toContain(step.title)
})

test("a valid step renders its goal/do/verify/tools and points to the next", () => {
  const first = renderLearnResult(1)
  expect(first).toContain(`Step 1/${LEARN_PATH.length}`)
  expect(first).toContain(LEARN_PATH[0]!.title)
  expect(first).toContain("Goal:")
  expect(first).toContain("Do:")
  expect(first).toContain("Verify:")
  expect(first).toContain("Tools:")
  expect(first).toContain(`Next:   step 2 (${LEARN_PATH[1]!.title})`)
})

test("the last step has no next - it ends the path", () => {
  const last = renderLearnResult(LEARN_PATH.length)
  expect(last).toContain(`Step ${LEARN_PATH.length}/${LEARN_PATH.length}`)
  expect(last).toContain("Done")
  expect(last).not.toContain("Next:   step")
})

test("an out-of-range step falls back to the index", () => {
  for (const bad of [0, LEARN_PATH.length + 1, 999]) {
    const out = renderLearnResult(bad)
    expect(out).toContain(`No step ${bad}`)
    expect(out).toContain(`${LEARN_PATH.length} steps`)
  }
})

test("the path is well-formed: unique ids, non-empty fields, and real nifra_* tool references", () => {
  const ids = new Set<string>()
  for (const step of LEARN_PATH) {
    expect(step.id).toMatch(/^[a-z][a-z-]*$/)
    expect(ids.has(step.id)).toBe(false)
    ids.add(step.id)
    expect(step.title.length).toBeGreaterThan(0)
    expect(step.goal.length).toBeGreaterThan(0)
    expect(step.do.length).toBeGreaterThan(0)
    expect(step.verify.length).toBeGreaterThan(0)
    expect(step.tools.length).toBeGreaterThan(0)
    for (const tool of step.tools) expect(tool).toMatch(/^nifra_[a-z]+$/)
  }
})
