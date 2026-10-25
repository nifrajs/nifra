/** The slice of a body reader the capped readers use; `getReader()` is cast to it at each call site. */
export interface ChunkReader {
  read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>
  cancel(reason?: unknown): Promise<void>
  releaseLock(): void
}

export function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * `res` again, its body the already-read `chunks` followed by the rest of `reader`: the prefix is
 * replayed through the same reader instead of cancelling a clone, which can stall the original body on
 * some runtimes. The lock is released once the reader ends, fails, or is cancelled.
 */
export function replayFrom(
  res: Response,
  chunks: readonly Uint8Array[],
  reader: ChunkReader,
): Response {
  let released = false
  const release = (): void => {
    if (!released) {
      released = true
      reader.releaseLock()
    }
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done || value === undefined) {
          release()
          controller.close()
        } else {
          controller.enqueue(value)
        }
      } catch (error) {
        release()
        controller.error(error)
      }
    },
    cancel: (reason) => reader.cancel(reason).finally(release),
  })
  return new Response(stream, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}
