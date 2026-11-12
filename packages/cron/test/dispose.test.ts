import { expect, spyOn, test } from "bun:test"
import { createScheduler } from "../src/index.ts"

test("using a started scheduler clears its timer when the scope ends", () => {
  const clear = spyOn(globalThis, "clearInterval")
  try {
    {
      using scheduler = createScheduler()
      scheduler.start(60_000)
      expect(clear).not.toHaveBeenCalled()
    }
    expect(clear).toHaveBeenCalledTimes(1)
  } finally {
    clear.mockRestore()
  }
})

test("disposing a scheduler that never started does nothing", () => {
  const scheduler = createScheduler()
  expect(() => scheduler[Symbol.dispose]()).not.toThrow()
})
