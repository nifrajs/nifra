import { ServerComponentError } from "./error.ts"

interface PendingTask {
  readonly signal: AbortSignal
  readonly start: () => void
  readonly reject: (reason: unknown) => void
  readonly cancel: () => void
}

export function componentAbort(signal: AbortSignal): ServerComponentError {
  return new ServerComponentError(
    signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
      ? "component_timeout"
      : "component_cancelled",
    504,
  )
}

function retainStreamUntilSettled<T>(
  source: ReadableStream<T>,
  signal: AbortSignal,
  release: () => void,
): ReadableStream<T> {
  const reader = source.getReader()
  let settled = false
  let cancelling = false
  let reading = false
  let readerReleased = false
  let cancellation: Promise<void> | undefined
  let controller: ReadableStreamDefaultController<T> | undefined

  const releaseReader = (): void => {
    if (!settled || reading || readerReleased) return
    readerReleased = true
    try {
      reader.releaseLock()
    } catch {
      // A cancelled source may reject releasing its lock; the admission lease still settles.
    }
  }
  const finish = (): boolean => {
    if (settled) return false
    settled = true
    signal.removeEventListener("abort", abort)
    releaseReader()
    release()
    return true
  }
  const cancelSource = (reason: unknown): Promise<void> => {
    if (settled) return Promise.resolve()
    if (cancellation !== undefined) return cancellation
    cancelling = true
    cancellation = Promise.resolve()
      .then(() => reader.cancel(reason))
      .catch(() => undefined)
      .then(() => {
        finish()
      })
    return cancellation
  }
  const abort = (): void => {
    if (settled) return
    void cancelSource(signal.reason).then(() => {
      try {
        controller?.error(componentAbort(signal))
      } catch {
        // A concurrent downstream cancellation already owns the stream's terminal state.
      }
    })
  }

  const retained = new ReadableStream<T>({
    start(value) {
      controller = value
    },
    async pull(value) {
      if (settled || cancelling) return
      reading = true
      try {
        const next = await reader.read()
        if (settled || cancelling) return
        if (next.done) {
          finish()
          value.close()
        } else {
          value.enqueue(next.value)
        }
      } catch (error) {
        if (finish()) {
          try {
            value.error(error)
          } catch {
            // A concurrent downstream cancellation already owns the stream's terminal state.
          }
        }
      } finally {
        reading = false
        releaseReader()
      }
    },
    cancel(reason) {
      return cancelSource(reason)
    },
  })
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  return retained
}

export class BoundedComponentTasks {
  #active = 0
  readonly #queue: PendingTask[] = []
  constructor(
    readonly concurrency: number,
    readonly capacity: number,
  ) {
    if (
      !Number.isSafeInteger(concurrency) ||
      concurrency < 1 ||
      !Number.isSafeInteger(capacity) ||
      capacity < 0
    )
      throw new ServerComponentError("component_contract")
  }
  get counts(): { active: number; queued: number } {
    return { active: this.#active, queued: this.#queue.length }
  }

  run<T>(signal: AbortSignal, work: () => T | Promise<T>): Promise<T> {
    return this.#acquire(signal).then((release) => {
      if (signal.aborted) {
        release()
        throw componentAbort(signal)
      }
      let rejectAbort = (_reason: unknown): void => {}
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject
      })
      const cancel = (): void => rejectAbort(componentAbort(signal))
      signal.addEventListener("abort", cancel, { once: true })
      let task: Promise<T>
      try {
        if (signal.aborted) throw componentAbort(signal)
        task = Promise.resolve(work())
      } catch (error) {
        task = Promise.reject(error)
      }
      const completed = task.then(
        (value) => {
          signal.removeEventListener("abort", cancel)
          release()
          return value
        },
        (error: unknown) => {
          signal.removeEventListener("abort", cancel)
          release()
          throw error
        },
      )
      // The caller may stop waiting on abort; the lease follows the actual work to completion.
      return Promise.race([completed, aborted])
    })
  }

  async runStream<T>(
    signal: AbortSignal,
    work: () => ReadableStream<T> | Promise<ReadableStream<T>>,
  ): Promise<ReadableStream<T>> {
    const release = await this.#acquire(signal)
    try {
      if (signal.aborted) throw componentAbort(signal)
      const stream = await work()
      if (signal.aborted) {
        // The source may still own React work or buffered bytes. Keep its admission lease until its
        // cancellation hook settles, just as the retained wrapper does after response delivery.
        await stream.cancel(signal.reason).catch(() => {})
        throw componentAbort(signal)
      }
      return retainStreamUntilSettled(stream, signal, release)
    } catch (error) {
      release()
      throw error
    }
  }

  #acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(componentAbort(signal))
    if (this.#active >= this.concurrency && this.#queue.length >= this.capacity)
      return Promise.reject(new ServerComponentError("component_busy", 429))
    return new Promise((resolve, reject) => {
      let began = false
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        this.#active--
        const next = this.#queue.shift()
        if (next !== undefined) next.start()
      }
      const cancel = (): void => {
        if (!began) {
          const index = this.#queue.indexOf(pending)
          if (index !== -1) this.#queue.splice(index, 1)
          signal.removeEventListener("abort", cancel)
        }
        reject(componentAbort(signal))
      }
      const start = (): void => {
        began = true
        signal.removeEventListener("abort", cancel)
        this.#active++
        resolve(release)
      }
      const pending: PendingTask = { signal, start, reject, cancel }
      signal.addEventListener("abort", cancel, { once: true })
      if (this.#active < this.concurrency) start()
      else this.#queue.push(pending)
    })
  }
}
