import { expect, test } from "bun:test"
import { BoundedComponentTasks, componentAbort } from "../src/server-components/scheduler.ts"

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

test("stream admission stays held until the source closes, then starts queued work", async () => {
  const tasks = new BoundedComponentTasks(1, 1)
  let closeSource!: () => void
  const first = await tasks.runStream(
    new AbortController().signal,
    () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          closeSource = () => controller.close()
        },
      }),
  )
  let secondStarted = false
  const second = tasks.runStream(new AbortController().signal, () => {
    secondStarted = true
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    })
  })

  await Promise.resolve()
  expect(secondStarted).toBe(false)
  expect(tasks.counts).toEqual({ active: 1, queued: 1 })

  closeSource()
  await second
  await first.getReader().read()
  expect(secondStarted).toBe(true)
  expect(tasks.counts).toEqual({ active: 0, queued: 0 })
})

test("stream admission releases after a source error", async () => {
  const tasks = new BoundedComponentTasks(1, 0)
  const failure = new Error("flight failed")
  const stream = await tasks.runStream(
    new AbortController().signal,
    () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(failure)
        },
      }),
  )

  await expect(stream.getReader().read()).rejects.toBe(failure)
  expect(tasks.counts).toEqual({ active: 0, queued: 0 })
})

test("stream admission waits for the source cancellation to settle", async () => {
  const tasks = new BoundedComponentTasks(1, 0)
  let finishCancel!: () => void
  const cancelFinished = new Promise<void>((resolve) => {
    finishCancel = resolve
  })
  const stream = await tasks.runStream(
    new AbortController().signal,
    () =>
      new ReadableStream<Uint8Array>({
        cancel() {
          return cancelFinished
        },
      }),
  )

  const cancellation = stream.cancel("client disconnected")
  await Promise.resolve()
  expect(tasks.counts).toEqual({ active: 1, queued: 0 })

  finishCancel()
  await cancellation
  expect(tasks.counts).toEqual({ active: 0, queued: 0 })
})

test("abort during stream creation retains admission until source cancellation settles", async () => {
  const tasks = new BoundedComponentTasks(1, 1)
  const signal = new AbortController()
  let resolveStream!: (stream: ReadableStream<Uint8Array>) => void
  let finishCancel!: () => void
  let secondStarted = false
  const cancelFinished = new Promise<void>((resolve) => {
    finishCancel = resolve
  })
  const first = tasks.runStream(
    signal.signal,
    () =>
      new Promise<ReadableStream<Uint8Array>>((resolve) => {
        resolveStream = resolve
      }),
  )

  await new Promise((resolve) => setTimeout(resolve, 0))
  signal.abort("client disconnected")
  resolveStream(
    new ReadableStream<Uint8Array>({
      cancel() {
        return cancelFinished
      },
    }),
  )
  await new Promise((resolve) => setTimeout(resolve, 0))

  const second = tasks.runStream(new AbortController().signal, () => {
    secondStarted = true
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    })
  })
  await Promise.resolve()
  expect(secondStarted).toBe(false)
  expect(tasks.counts).toEqual({ active: 1, queued: 1 })

  finishCancel()
  await expect(first).rejects.toMatchObject({ code: "component_cancelled" })
  const secondStream = await second
  await secondStream.getReader().read()
  expect(tasks.counts).toEqual({ active: 0, queued: 0 })
})

test("invalid scheduler limits fail closed and abort reasons preserve timeouts", () => {
  expect(() => new BoundedComponentTasks(0, 1)).toThrow()
  const timeout = new AbortController()
  timeout.abort(new DOMException("deadline", "TimeoutError"))
  expect(componentAbort(timeout.signal)).toMatchObject({ code: "component_timeout", status: 504 })
})

test("a task aborted just after admission releases its lease without running work", async () => {
  const tasks = new BoundedComponentTasks(1, 0)
  const controller = new AbortController()
  let invoked = false
  const task = tasks.run(controller.signal, () => {
    invoked = true
  })

  controller.abort()
  await expect(task).rejects.toMatchObject({ code: "component_cancelled" })
  expect(invoked).toBe(false)
  expect(tasks.counts).toEqual({ active: 0, queued: 0 })
})

test("a stream aborted just after admission never starts its renderer", async () => {
  const tasks = new BoundedComponentTasks(1, 0)
  const controller = new AbortController()
  let started = false
  const stream = tasks.runStream(controller.signal, () => {
    started = true
    return new ReadableStream<Uint8Array>()
  })

  controller.abort()
  await expect(stream).rejects.toMatchObject({ code: "component_cancelled" })
  expect(started).toBe(false)
  expect(tasks.counts).toEqual({ active: 0, queued: 0 })
})

test("a synchronous task failure releases its admission lease", async () => {
  const tasks = new BoundedComponentTasks(1, 0)
  const failure = new Error("work failed before returning")
  await expect(
    tasks.run(new AbortController().signal, () => {
      throw failure
    }),
  ).rejects.toBe(failure)
  expect(tasks.counts).toEqual({ active: 0, queued: 0 })
})

test("an aborted live stream holds admission until source cleanup, then errors its reader", async () => {
  const tasks = new BoundedComponentTasks(1, 0)
  const controller = new AbortController()
  let finishCancel!: () => void
  let cancellationStarted = false
  const cleanup = new Promise<void>((resolve) => {
    finishCancel = resolve
  })
  const stream = await tasks.runStream(
    controller.signal,
    () =>
      new ReadableStream<Uint8Array>({
        cancel() {
          cancellationStarted = true
          return cleanup
        },
      }),
  )
  const read = stream.getReader().read()

  controller.abort(new DOMException("deadline", "TimeoutError"))
  await Promise.resolve()
  expect(cancellationStarted).toBe(true)
  expect(tasks.counts).toEqual({ active: 1, queued: 0 })

  finishCancel()
  await expect(read).rejects.toMatchObject({ code: "component_timeout" })
  expect(tasks.counts).toEqual({ active: 0, queued: 0 })
})

test("a late abort notification after stream completion is ignored", async () => {
  const tasks = new BoundedComponentTasks(1, 0)
  const controller = new AbortController()
  const stream = await tasks.runStream(
    controller.signal,
    () =>
      new ReadableStream<Uint8Array>({
        start(value) {
          value.close()
        },
      }),
  )

  const reader = stream.getReader()
  await reader.read()
  expect(tasks.counts).toEqual({ active: 0, queued: 0 })
  controller.abort()
  expect(tasks.counts).toEqual({ active: 0, queued: 0 })
})

test("an abort during stream retention setup cancels before the stream is returned", async () => {
  const tasks = new BoundedComponentTasks(1, 0)
  const controller = new AbortController()
  let cancelled = false
  const source = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true
    },
  })
  const getReader = source.getReader.bind(source)
  Object.defineProperty(source, "getReader", {
    configurable: true,
    value: () => {
      controller.abort("client disconnected")
      return getReader()
    },
  })

  const stream = await tasks.runStream(controller.signal, () => source)
  await expect(stream.getReader().read()).rejects.toMatchObject({ code: "component_cancelled" })
  expect(cancelled).toBe(true)
  expect(tasks.counts).toEqual({ active: 0, queued: 0 })
})

test("reader cleanup failure does not leak stream admission", async () => {
  const tasks = new BoundedComponentTasks(1, 0)
  const source = new ReadableStream<Uint8Array>({
    start(value) {
      value.enqueue(new Uint8Array([1]))
      value.close()
    },
  })
  const getReader = source.getReader.bind(source)
  Object.defineProperty(source, "getReader", {
    configurable: true,
    value: () => {
      const reader = getReader()
      Object.defineProperty(reader, "releaseLock", {
        configurable: true,
        value: () => {
          throw new Error("simulated reader cleanup race")
        },
      })
      return reader
    },
  })
  const stream = await tasks.runStream(new AbortController().signal, () => source)
  const reader = stream.getReader()
  await reader.read()
  await reader.read()
  expect(tasks.counts).toEqual({ active: 0, queued: 0 })
})

test("a late source error is contained when the downstream controller is already closed", async () => {
  const tasks = new BoundedComponentTasks(1, 0)
  const failure = new Error("source failed")
  const source = new ReadableStream<Uint8Array>({
    start(value) {
      value.error(failure)
    },
  })
  const prototype = ReadableStreamDefaultController.prototype
  const originalError = prototype.error
  Object.defineProperty(prototype, "error", {
    configurable: true,
    writable: true,
    value: function (this: ReadableStreamDefaultController<Uint8Array>, reason: unknown) {
      Reflect.apply(originalError, this, [reason])
      throw new Error("simulated downstream close race")
    },
  })

  try {
    const stream = await tasks.runStream(new AbortController().signal, () => source)
    await expect(stream.getReader().read()).rejects.toBe(failure)
    expect(tasks.counts).toEqual({ active: 0, queued: 0 })
  } finally {
    Object.defineProperty(prototype, "error", {
      configurable: true,
      writable: true,
      value: originalError,
    })
  }
})

test("a rejected source cancellation still releases stream admission", async () => {
  const tasks = new BoundedComponentTasks(1, 0)
  let cancelled = false
  const stream = await tasks.runStream(
    new AbortController().signal,
    () =>
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true
          return Promise.reject(new Error("source cancellation failed"))
        },
      }),
  )

  await expect(stream.cancel("client disconnected")).resolves.toBeUndefined()
  expect(cancelled).toBe(true)
  expect(tasks.counts).toEqual({ active: 0, queued: 0 })
})

test("abort during stream creation releases admission when source cancellation rejects", async () => {
  const tasks = new BoundedComponentTasks(1, 0)
  const controller = new AbortController()
  let started!: () => void
  let resolveStream!: (stream: ReadableStream<Uint8Array>) => void
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve
  })
  const result = tasks.runStream(
    controller.signal,
    () =>
      new Promise<ReadableStream<Uint8Array>>((resolve) => {
        resolveStream = resolve
        started()
      }),
  )
  await startedPromise

  controller.abort()
  resolveStream(
    new ReadableStream<Uint8Array>({
      cancel() {
        return Promise.reject(new Error("source cleanup failed"))
      },
    }),
  )
  await expect(result).rejects.toMatchObject({ code: "component_cancelled" })
  expect(tasks.counts).toEqual({ active: 0, queued: 0 })
})

test("abort after downstream cancellation contains a terminal controller race", async () => {
  const tasks = new BoundedComponentTasks(1, 0)
  const abortController = new AbortController()
  let finishCancel!: () => void
  let cancellationStarted!: () => void
  const started = new Promise<void>((resolve) => {
    cancellationStarted = resolve
  })
  const cleanup = new Promise<void>((resolve) => {
    finishCancel = resolve
  })
  const stream = await tasks.runStream(
    abortController.signal,
    () =>
      new ReadableStream<Uint8Array>({
        cancel() {
          cancellationStarted()
          return cleanup
        },
      }),
  )
  const prototype = ReadableStreamDefaultController.prototype
  const originalError = prototype.error
  Object.defineProperty(prototype, "error", {
    configurable: true,
    writable: true,
    value: function (this: ReadableStreamDefaultController<Uint8Array>, reason: unknown) {
      Reflect.apply(originalError, this, [reason])
      throw new Error("simulated downstream cancellation race")
    },
  })

  try {
    const cancelling = stream.getReader().cancel("client disconnected")
    await started
    abortController.abort()
    finishCancel()
    await cancelling
    expect(tasks.counts).toEqual({ active: 0, queued: 0 })
  } finally {
    Object.defineProperty(prototype, "error", {
      configurable: true,
      writable: true,
      value: originalError,
    })
  }
})
