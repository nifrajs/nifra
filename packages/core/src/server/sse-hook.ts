/**
 * The `SseRuntime` contract - the streaming implementation that `.use(streaming())` installs (from
 * `@nifrajs/core/sse`). `server.ts` type-imports only this, so the ReadableStream framing code stays
 * out of a bare server bundle until a route opts in.
 */
import type { SSEContext, SSEInit, TypedSSEStream } from "./sse.ts"

export interface SseRuntime {
  response<Event>(
    context: SSEContext,
    run: (stream: TypedSSEStream<Event>) => void | Promise<void>,
    init?: SSEInit,
  ): Response
}
