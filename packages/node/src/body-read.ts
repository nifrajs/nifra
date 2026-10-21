export interface BodyReadState {
  readonly onData: (chunk: Buffer | string) => void
  readonly onDone: (error?: unknown) => void
  bytes(): Buffer
  finish(body: Buffer): void
  fail(error: unknown): void
}

const EMPTY = Buffer.alloc(0)

export class NodeBodyRead<T> implements BodyReadState {
  readonly result: Promise<T>
  readonly onData: (chunk: Buffer | string) => void
  readonly onDone: (error?: unknown) => void
  private readonly map: (body: Buffer) => T
  // The Promise executor runs synchronously and initializes both callbacks before this instance escapes.
  private accept!: (value: T | PromiseLike<T>) => void
  private reject!: (error: unknown) => void
  private first: Buffer | undefined
  private chunks: Buffer[] | undefined
  private total = 0

  constructor(map: (body: Buffer) => T, onDone: (error?: unknown) => void) {
    this.map = map
    this.onData = this.add.bind(this)
    this.onDone = onDone
    this.result = new Promise<T>((resolve, reject) => {
      this.accept = resolve
      this.reject = reject
    })
  }

  add(chunk: Buffer | string): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk
    if (this.first === undefined) this.first = bytes
    else {
      this.chunks ??= [this.first]
      this.chunks.push(bytes)
    }
    this.total += bytes.byteLength
  }

  bytes(): Buffer {
    return this.chunks === undefined
      ? (this.first ?? EMPTY)
      : Buffer.concat(this.chunks, this.total)
  }

  finish(body: Buffer): void {
    try {
      this.accept(this.map(body))
    } catch (error) {
      this.reject(error)
    }
  }

  fail(error: unknown): void {
    this.reject(error)
  }
}
