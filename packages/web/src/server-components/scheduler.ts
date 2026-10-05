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
    if (signal.aborted) return Promise.reject(componentAbort(signal))
    if (this.#active >= this.concurrency && this.#queue.length >= this.capacity)
      return Promise.reject(new ServerComponentError("component_busy", 429))
    return new Promise<T>((resolve, reject) => {
      let began = false
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
        this.#active++
        const complete = (): void => {
          signal.removeEventListener("abort", cancel)
          this.#active--
          const next = this.#queue.shift()
          if (next !== undefined) next.start()
        }
        // Admission is released by actual completion, never by the public promise's abort.
        void Promise.resolve()
          .then(() => {
            if (signal.aborted) throw componentAbort(signal)
            return work()
          })
          .then(
            (value) => {
              complete()
              resolve(value)
            },
            (error: unknown) => {
              complete()
              reject(error)
            },
          )
      }
      const pending: PendingTask = { signal, start, reject, cancel }
      signal.addEventListener("abort", cancel, { once: true })
      if (this.#active < this.concurrency) start()
      else this.#queue.push(pending)
    })
  }
}
