import { expect, test } from "bun:test"
import { canonicalJson, digestRunPlan } from "../src/orchestration/index.ts"

// Run-plan digests and evidence-store lines are stored, so their bytes are pinned literally.
test("canonical JSON and the run-plan digest are pinned", async () => {
  const value = { b: [2, { d: null, c: "\u00e9" }], a: 1, omitted: undefined }
  expect(canonicalJson(value)).toBe('{"a":1,"b":[2,{"c":"\u00e9","d":null}]}')
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: digestRunPlan hashes the plan as given and reads none of its fields.
  expect(await digestRunPlan(value as never)).toBe(
    "4ef06c6436bffc91583e5acdec283e4b431eca3b12eee6c9bbcd49081966c5e7",
  )
})
