import type { HttpResponse } from "./uws.ts"

/**
 * Buffered request bytes above which the socket is throttled until a reader catches up. uWS pushes
 * body data whether or not anything asked for it (Node waits to be read), so a handler that answers
 * after a slow `await` would otherwise buffer whatever a client cares to send in the meantime.
 */
export const BODY_HIGH_WATER = 1 << 20

const EMPTY = Buffer.alloc(0)

/**
 * A request body as uWS delivers it: pushed chunks, copied out (uWS neuters the ArrayBuffer when the
 * callback returns), consumed once as a stream or as one buffer. Reads are pull-driven, so the socket
 * is paused while more than {@link BODY_HIGH_WATER} bytes wait.
 */
export class BodyChannel {
  private readonly res: HttpResponse
  private chunks: Buffer[] = []
  private queued = 0
  private ended = false
  private failure: unknown
  private paused = false
  private waiters: Array<() => void> = []
  private all: Promise<Buffer> | undefined
  private streamValue: ReadableStream<Uint8Array> | undefined
  private pulled = false
  private discarded = false
  private gone = false
  private collecting = false

  constructor(res: HttpResponse) {
    this.res = res
    res.onData((chunk, isLast) => {
      // uWS keeps delivering an upload after the answer went out; the response is no longer ours to touch.
      if (this.gone) return
      if (chunk.byteLength > 0 && !this.discarded) {
        // uWS neuters `chunk` when this returns. A pooled copy: no backing store per small body.
        const view = new Uint8Array(chunk)
        const copy = Buffer.allocUnsafe(view.byteLength)
        copy.set(view)
        this.chunks.push(copy)
        this.queued += chunk.byteLength
        if (!isLast && !this.paused && !this.collecting && this.queued >= BODY_HIGH_WATER) {
          this.paused = true
          res.pause()
        }
      }
      if (isLast) this.ended = true
      this.wakeAll()
    })
  }

  /** The request body arrived in full and was never cut short. */
  get complete(): boolean {
    return this.ended && this.failure === undefined
  }

  /** The response ended or the connection closed: drop what is buffered and stop touching `res`. */
  close(): void {
    this.gone = true
    this.paused = false
    this.chunks = []
    this.queued = 0
    this.wakeAll()
  }

  /** The client went away before the body finished. */
  abort(reason: unknown): void {
    if (this.ended) return
    this.failure = reason
    this.ended = true
    this.wakeAll()
  }

  private release(): void {
    if (!this.gone && this.paused && this.queued < BODY_HIGH_WATER) {
      this.paused = false
      this.res.resume()
    }
  }

  private wakeAll(): void {
    const waiting = this.waiters
    if (waiting.length === 0) return
    this.waiters = []
    for (const resolve of waiting) resolve()
  }

  private waitForData(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  /** The whole body. Unusable once the {@link stream} has been read from, as a read `Request` is. */
  bytes(): Promise<Buffer> {
    if (this.pulled) return Promise.reject(new TypeError("Body is unusable: it was already read"))
    this.all ??= this.collect()
    return this.all
  }

  private async collect(): Promise<Buffer> {
    // A reader that wants every byte has no use for the throttle; the cap on how much it may take
    // is the caller's (core checks Content-Length before it reads, and caps a chunked body itself).
    this.collecting = true
    if (this.paused && !this.gone) {
      this.paused = false
      this.res.resume()
    }
    while (!this.ended && !this.gone) await this.waitForData()
    if (this.failure !== undefined) throw this.failure
    if (!this.ended) throw new Error("request closed before body completed")
    const [only] = this.chunks
    const body =
      only === undefined
        ? EMPTY
        : this.chunks.length === 1
          ? only
          : Buffer.concat(this.chunks, this.queued)
    this.chunks = []
    this.queued = 0
    this.release()
    return body
  }

  /** The body as a pull-driven stream; cancelling it drops the rest of the upload. */
  stream(): ReadableStream<Uint8Array> {
    if (this.all !== undefined) {
      const replay = this.all
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const body = await replay
            if (body.byteLength > 0) controller.enqueue(body)
            controller.close()
          } catch (error) {
            controller.error(error)
          }
        },
      })
    }
    this.streamValue ??= new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          this.pulled = true
          for (;;) {
            const next = this.chunks.shift()
            if (next !== undefined) {
              this.queued -= next.byteLength
              this.release()
              controller.enqueue(next)
              return
            }
            if (this.ended) {
              if (this.failure !== undefined) controller.error(this.failure)
              else controller.close()
              return
            }
            if (this.gone) {
              controller.error(new Error("request closed before body completed"))
              return
            }
            this.release()
            await this.waitForData()
          }
        },
        cancel: () => {
          this.discarded = true
          this.chunks = []
          this.queued = 0
          this.release()
        },
      },
      { highWaterMark: 0 },
    )
    return this.streamValue
  }
}
