import { expect, test } from "bun:test"
import { BoundedComponentTasks } from "../src/server-components/scheduler.ts"

test("abandoned uncooperative work retains admission until it actually finishes", async () => {
  const tasks = new BoundedComponentTasks(1, 1)
  let finish: (() => void) | undefined
  let second = false
  const signal = new AbortController()
  const first = tasks.run(
    signal.signal,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  await Promise.resolve()
  signal.abort()
  await expect(first).rejects.toMatchObject({ code: "component_cancelled" })
  const queued = tasks.run(new AbortController().signal, async () => {
    second = true
  })
  await Promise.resolve()
  expect(second).toBe(false)
  await expect(tasks.run(new AbortController().signal, async () => {})).rejects.toMatchObject({
    code: "component_busy",
  })
  finish?.()
  await queued
  expect(second).toBe(true)
  expect(tasks.counts).toEqual({ active: 0, queued: 0 })
})

test("cancelling queued work removes it without invoking the loader", async () => {
  const tasks = new BoundedComponentTasks(1, 1)
  let finish: (() => void) | undefined
  const first = tasks.run(
    new AbortController().signal,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  await Promise.resolve()
  const signal = new AbortController()
  let invoked = false
  const queued = tasks.run(signal.signal, async () => {
    invoked = true
  })
  signal.abort()
  await expect(queued).rejects.toMatchObject({ code: "component_cancelled" })
  finish?.()
  await first
  expect(invoked).toBe(false)
  expect(tasks.counts).toEqual({ active: 0, queued: 0 })
})
