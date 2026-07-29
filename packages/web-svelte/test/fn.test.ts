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

/**
 * Call first, subscribe after - the ordering the tests above deliberately avoid, and the one real apps
 * hit: a handle created at module scope, or put in a Svelte context and shared, or read by a component
 * that mounts after the call was made.
 *
 * Svelte's `readable` runs its start function only on the FIRST subscription, so a store that
 * subscribes without priming reports its initial value - idle - for a call that already finished. The
 * four sibling adapters read a snapshot, so this was the one place "is it pending" gave a different
 * answer from the shared state machine it is supposed to be reporting.
 */
test("a late subscriber sees the finished call, not idle", async () => {
  const handle = useServerFn(async (input: { text: string }) => `${input.text}!`)

  await handle.call({ text: "hi" })

  // Nothing has subscribed yet. The first read must reflect the store, not the initial value.
  const seen: Array<{ pending: boolean; data: string | undefined }> = []
  const unsubscribe = handle.state.subscribe((s) => seen.push({ pending: s.pending, data: s.data }))
  expect(seen[0]).toEqual({ pending: false, data: "hi!" })
  expect(get(handle.state)).toMatchObject({ pending: false, data: "hi!" })
  unsubscribe()
})

test("a subscriber attaching mid-flight sees pending, not idle", async () => {
  let release!: (value: string) => void
  const gate = new Promise<string>((resolve) => {
    release = resolve
  })
  const handle = useServerFn(() => gate)

  const call = handle.call(undefined)
  const seen: boolean[] = []
  const unsubscribe = handle.state.subscribe((s) => seen.push(s.pending))
  expect(seen[0]).toBe(true) // in flight when it attached

  release("done")
  await call
  expect(get(handle.state)).toMatchObject({ pending: false, data: "done" })
  unsubscribe()
})
