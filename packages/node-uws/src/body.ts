import type { HttpResponse } from "./uws.ts"

/**
 * Buffered request bytes above which the socket is throttled until a reader catches up. uWS pushes
 * body data whether or not anything asked for it (Node waits to be read), so a handler that answers
 * after a slow `await` would otherwise buffer whatever a client cares to send in the meantime.
 */
export const BODY_HIGH_WATER = 1 << 20

const EMPTY = Buffer.alloc(0)
const identity = (body: Buffer): Buffer => body

/** A pending whole-body read: `run` maps the complete body inside the one promise it settles. */
interface Reader {
  run(body: Buffer): void
  readonly reject: (reason: unknown) => void
}
const UNREAD = "Body is unusable: the response was already being sent"

/**
 * A request body as uWS delivers it: pushed chunks, copied out (uWS neuters the ArrayBuffer when the
 * callback returns), consumed once as a stream or as one buffer. Reads are pull-driven, so the socket
 * is paused while more than {@link BODY_HIGH_WATER} bytes wait.
 */
export class BodyChannel {
  private readonly res: HttpResponse
  private chunks: Buffer[] = []
  private head = 0
  private queued = 0
  private ended = false
  private failure: unknown
  private paused = false
  private waiters: Array<() => void> | undefined
  private readers: Reader[] | undefined
  private whole: Buffer | undefined
  private streamValue: ReadableStream<Uint8Array> | undefined
  private pulled = false
  private discarded = false
  private gone = false
  private aborted = false
  private lifted = false
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
        // Lifted with nobody reading: a long-lived response must not keep buffering the upload.
        if (this.lifted && this.queued >= BODY_HIGH_WATER) {
          this.discarded = true
          this.chunks = []
          this.head = 0
          this.queued = 0
        }
        if (
          !isLast &&
          !this.paused &&
          !this.collecting &&
          !this.lifted &&
          this.queued >= BODY_HIGH_WATER
        ) {
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
    this.head = 0
    this.queued = 0
    this.wakeAll()
  }

  /**
   * The answer is about to be written. A body nothing has started to read never will be, so it stops
   * being buffered and throttled: a socket left paused here cannot be resumed once the response ends
   * (uWS invalidates `res` then), and the next request on the connection would never be read. A body
   * with a reader keeps its own flow control. A stream handed out that nothing has pulled yet may still
   * be read by the response, so it keeps its bytes and stops throttling instead. Nobody reading by
   * {@link BODY_HIGH_WATER} bytes means nobody will, and the upload is dropped; a reader that starts
   * first takes back the normal flow control.
   */
  unthrottle(): void {
    if (this.gone || this.aborted || this.collecting || this.pulled) return
    if (this.streamValue === undefined) {
      this.discarded = true
      this.chunks = []
      this.head = 0
      this.queued = 0
    } else this.lifted = true
    if (this.paused) {
      this.paused = false
      this.res.resume()
    }
  }

  /** The client went away before the body finished. */
  abort(reason: unknown): void {
    this.aborted = true
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
    const readers = this.readers
    if (readers !== undefined && (this.ended || this.gone)) {
      this.readers = undefined
      for (const reader of readers) this.deliver(reader)
    }
    const waiting = this.waiters
    if (waiting === undefined) return
    this.waiters = undefined
    for (const resolve of waiting) resolve()
  }

  private waitForData(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.waiters === undefined) this.waiters = [resolve]
      else this.waiters.push(resolve)
    })
  }

  private deliver(reader: Reader): void {
    if (this.failure !== undefined) {
      reader.reject(this.failure)
      return
    }
    if (!this.ended) {
      reader.reject(new Error("request closed before body completed"))
      return
    }
    reader.run(this.bodyOnce())
  }

  /** The whole body. Unusable once the {@link stream} has been read from, as a read `Request` is. */
  bytes(): Promise<Buffer> {
    return this.read(identity)
  }

  /**
   * The whole body passed through `map`, in one promise: a body that is already complete is mapped on
   * the spot, and one still arriving is mapped by the `onData` callback that completes it, so a JSON
   * read costs no promise beyond the one the caller awaits. A `map` that throws rejects that promise.
   */
  read<T>(map: (body: Buffer) => T): Promise<T> {
    if (this.discarded) return Promise.reject(new TypeError(UNREAD))
    if (this.pulled) return Promise.reject(new TypeError("Body is unusable: it was already read"))
    // A reader that wants every byte has no use for the throttle; the cap on how much it may take
    // is the caller's (core checks Content-Length before it reads, and caps a chunked body itself).
    this.collecting = true
    this.lifted = false
    if (this.paused && !this.gone) {
      this.paused = false
      this.res.resume()
    }
    if (this.ended || this.gone) {
      if (this.failure !== undefined) return Promise.reject(this.failure)
      if (!this.ended) return Promise.reject(new Error("request closed before body completed"))
      try {
        return Promise.resolve(map(this.bodyOnce()))
      } catch (error) {
        return Promise.reject(error)
      }
    }
    return new Promise<T>((resolve, reject) => {
      const reader: Reader = {
        run: (body) => {
          try {
            resolve(map(body))
          } catch (error) {
            reject(error)
          }
        },
        reject,
      }
      if (this.readers === undefined) this.readers = [reader]
      else this.readers.push(reader)
    })
  }

  private bodyOnce(): Buffer {
    if (this.whole === undefined) this.whole = this.takeBody()
    return this.whole
  }

  private takeBody(): Buffer {
    const [only] = this.chunks
    const body =
      only === undefined
        ? EMPTY
        : this.chunks.length === 1
          ? only
          : Buffer.concat(this.chunks, this.queued)
    this.chunks = []
    this.head = 0
    this.queued = 0
    this.release()
    return body
  }

  private shiftChunk(): Buffer | undefined {
    if (this.head >= this.chunks.length) return undefined
    const next = this.chunks[this.head]
    this.chunks[this.head] = EMPTY
    this.head++
    if (this.head >= this.chunks.length) {
      this.chunks.length = 0
      this.head = 0
    } else if (this.head >= 64 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head)
      this.head = 0
    }
    return next
  }

  /** The body as a pull-driven stream; cancelling it drops the rest of the upload. */
  stream(): ReadableStream<Uint8Array> {
    if (this.collecting) {
      const replay = this.bytes()
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
          if (this.discarded) return controller.error(new TypeError(UNREAD))
          this.pulled = true
          this.lifted = false
          for (;;) {
            const next = this.shiftChunk()
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
          this.head = 0
          this.queued = 0
          this.release()
        },
      },
      { highWaterMark: 0 },
    )
    return this.streamValue
  }
}
