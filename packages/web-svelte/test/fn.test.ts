import { expect, test } from "bun:test"
import { get } from "svelte/store"
import { useServerFn } from "../src/fn.ts"

/**
 * Svelte's `readable` only subscribes once someone reads it, so this subscribes explicitly - which is
 * what `$state` does in a component. The state machine is tested in `@nifrajs/web`'s suite; this is
 * the wiring between it and the store.
 */
test("tracks a call through its readable store", async () => {
  const handle = useServerFn(async (input: { text: string }) => `${input.text}!`)
  const seen: boolean[] = []
  const unsubscribe = handle.state.subscribe((s) => seen.push(s.pending))

  await handle.call({ text: "hi" })
  expect(get(handle.state)).toMatchObject({ pending: false, data: "hi!", error: undefined })
  // Subscribed before the call, so the pending transition was observed rather than just the result.
  expect(seen).toContain(true)

  handle.reset()
  expect(get(handle.state).data).toBeUndefined()
  unsubscribe()
})

test("a failure is recorded and the promise still rejects", async () => {
  const handle = useServerFn(async () => {
    throw new Error("boom")
  })
  const unsubscribe = handle.state.subscribe(() => {})
  await expect(handle.call(undefined)).rejects.toThrow("boom")
  expect(get(handle.state).error?.message).toBe("boom")
  unsubscribe()
})
