import { expect, test } from "bun:test"
import { createQueue } from "../src/index.ts"

test("await using a worker stops polling and awaits the job in flight", async () => {
  const q = createQueue({ onError: () => {} })
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started!: () => void
  const running = new Promise<void>((resolve) => {
    started = resolve
  })
  let finished = false
  q.define("slow", {
    async handler() {
      started()
      await gate
      finished = true
    },
  })
  await q.enqueue("slow", {})

  const scope = (async () => {
    await using worker = q.start({ pollIntervalMs: 1 })
    await running
    expect(worker.running).toBe(true)
    release()
    return worker
  })()
  const worker = await scope
  expect(worker.running).toBe(false)
  expect(finished).toBe(true)
})
