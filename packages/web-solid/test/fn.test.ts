import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { useServerFn } from "../src/fn.ts"

/**
 * Solid's binding subscribes eagerly and registers an `onCleanup`, so it is exercised inside a
 * `createRoot` - which is what a component provides. The state machine itself is tested in
 * `@nifrajs/web`'s suite; this is the wiring between it and a signal.
 */
test("tracks a call through its signal, and disposes cleanly", async () => {
  let dispose!: () => void
  const handle = createRoot((d) => {
    dispose = d
    return useServerFn(async (input: { text: string }) => input.text.toUpperCase())
  })

  expect(handle.state().pending).toBe(false)
  const call = handle.call({ text: "hi" })
  expect(handle.state().pending).toBe(true)
  await call
  expect(handle.state()).toMatchObject({ pending: false, data: "HI", error: undefined })

  handle.reset()
  expect(handle.state().data).toBeUndefined()
  dispose()
})
