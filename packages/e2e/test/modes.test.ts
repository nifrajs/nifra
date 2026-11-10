import { expect, test } from "bun:test"
import type { ModelRequest } from "../src/index.ts"
import { app, refusing } from "./replay-world.ts"

test("the refusing model counts the ask and throws", () => {
  const model = refusing()
  const request: ModelRequest = {
    kind: "assert",
    statement: "x",
    snapshot: "",
    secrets: [],
    signal: new AbortController().signal,
  }
  expect(() => model.decide(request)).toThrow("the model should not have been asked")
  expect(model.calls).toBe(1)
})

test("the world's app answers both start routes", async () => {
  for (const path of ["/", "/alt"]) {
    expect((await app.fetch(new Request(`http://x${path}`))).status).toBe(200)
  }
})
