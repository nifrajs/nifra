import { expect, test } from "bun:test"
import { updateProgressiveFlight } from "../src/server-components/progressive-update.ts"

function flightWithBranches(
  render: ReadableStream<Uint8Array>,
  snapshot: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const flight = new ReadableStream<Uint8Array>()
  Object.defineProperty(flight, "tee", { value: () => [render, snapshot] })
  return flight
}

function pendingStream(onCancel: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ cancel: onCancel })
}

test("progressive update cancels and observes its snapshot when Flight rendering rejects", async () => {
  let cancelSnapshot!: () => void
  const snapshotCancelled = new Promise<void>((resolve) => {
    cancelSnapshot = resolve
  })
  const failure = new Error("Flight decode failed")
  const update = updateProgressiveFlight(
    flightWithBranches(
      pendingStream(() => {}),
      pendingStream(cancelSnapshot),
    ),
    new AbortController().signal,
    () => true,
    async () => {
      throw failure
    },
    () => {},
  )

  await expect(update).rejects.toBe(failure)
  await snapshotCancelled
})

test("progressive update cancels its snapshot when the component is no longer current", async () => {
  let cancelSnapshot!: () => void
  const snapshotCancelled = new Promise<void>((resolve) => {
    cancelSnapshot = resolve
  })
  const update = updateProgressiveFlight(
    flightWithBranches(
      pendingStream(() => {}),
      pendingStream(cancelSnapshot),
    ),
    new AbortController().signal,
    () => false,
    async () => null,
    () => {},
  )

  await expect(update).rejects.toThrow("component_cancelled")
  await snapshotCancelled
})

test("progressive update cancels its snapshot when the request aborts before publication", async () => {
  let cancelSnapshot!: () => void
  const snapshotCancelled = new Promise<void>((resolve) => {
    cancelSnapshot = resolve
  })
  const controller = new AbortController()
  const update = updateProgressiveFlight(
    flightWithBranches(
      pendingStream(() => {}),
      pendingStream(cancelSnapshot),
    ),
    controller.signal,
    () => true,
    async () => {
      controller.abort(new Error("request disconnected"))
      return null
    },
    () => {},
  )

  await expect(update).rejects.toThrow("component_cancelled")
  await snapshotCancelled
})

test("progressive update returns the bounded snapshot after publishing the rendered tree", async () => {
  const bytes = new TextEncoder().encode('0:"public"\n')
  const snapshot = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
  let published: unknown
  const result = await updateProgressiveFlight(
    flightWithBranches(
      pendingStream(() => {}),
      snapshot,
    ),
    new AbortController().signal,
    () => true,
    async () => ({ tree: true }),
    (tree) => {
      published = tree
    },
  )

  expect(published).toEqual({ tree: true })
  expect(
    new TextDecoder().decode(Uint8Array.from(atob(result.flight), (byte) => byte.charCodeAt(0))),
  ).toBe('0:"public"\n')
})
