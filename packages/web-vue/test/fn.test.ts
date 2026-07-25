import { expect, test } from "bun:test"
import { effectScope } from "vue"
import { useServerFn } from "../src/fn.ts"

/**
 * Vue's binding registers an `onScopeDispose`, so it is exercised inside an `effectScope` - what a
 * component provides. The state machine is tested in `@nifrajs/web`'s suite; this is the wiring
 * between it and a `shallowRef`.
 */
test("tracks a call through its ref, and stops with the scope", async () => {
  const scope = effectScope()
  const handle = scope.run(() => useServerFn(async (input: { text: string }) => input.text.length))
  if (handle === undefined) throw new Error("the scope produced no handle")

  expect(handle.state.value.pending).toBe(false)
  const call = handle.call({ text: "four" })
  expect(handle.state.value.pending).toBe(true)
  await call
  expect(handle.state.value).toMatchObject({ pending: false, data: 4, error: undefined })

  handle.reset()
  expect(handle.state.value.data).toBeUndefined()
  scope.stop()
})
