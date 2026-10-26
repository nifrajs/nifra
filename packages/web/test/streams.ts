/** A byte stream of each chunk encoded in turn, closed after the last: the least a `renderToStream` returns. */
export const streamOf = (...chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}
