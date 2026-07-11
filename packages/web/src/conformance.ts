import type { RenderAdapter, RenderProps } from "./index.ts"

/** Framework-specific values that let the shared conformance module exercise a render adapter. */
export interface RenderAdapterConformanceFixture {
  /** A page that renders the `page`, `data`, and `pending` markers from the supplied props. */
  readonly page: unknown
  /** The outer layout, which renders `markers.outer` before its child. */
  readonly outerLayout: unknown
  /** The inner layout, which renders `markers.inner` before its child. */
  readonly innerLayout: unknown
  /** Props passed to the page. Use values represented by the `data` and `pending` markers. */
  readonly props: RenderProps
  /**
   * Set when the fixture renders **deferred/streaming-only** content (e.g. Suspense that resolves during
   * the stream). Streaming and buffered (`renderToString`) output then legitimately differ byte-for-byte,
   * so the hydration-equivalence check is relaxed to "buffered output still contains every marker" instead
   * of exact equality. Leave unset for plain synchronous content (the stricter, preferred check).
   */
  readonly deferred?: boolean
  /** Unique text fragments observable in the rendered HTML. */
  readonly markers: {
    readonly page: string
    readonly data: string
    readonly pending: string
    readonly outer: string
    readonly inner: string
  }
}

const fail = (check: string, message: string, cause?: unknown): never => {
  throw new RenderAdapterConformanceError(check, message, cause)
}

/** A failed invariant reported by {@link assertRenderAdapterConformance}. */
export class RenderAdapterConformanceError extends Error {
  constructor(
    readonly check: string,
    message: string,
    cause?: unknown,
  ) {
    super(`RenderAdapter conformance failed (${check}): ${message}`, { cause })
    this.name = "RenderAdapterConformanceError"
  }
}

const contains = (html: string, marker: string, check: string): void => {
  if (!html.includes(marker)) fail(check, `rendered HTML is missing ${JSON.stringify(marker)}`)
}

const readHtml = async (
  render: () => ReturnType<RenderAdapter["renderToStream"]>,
  check: string,
): Promise<string> => {
  let stream: ReadableStream<Uint8Array> | undefined
  try {
    stream = await render()
  } catch (error) {
    fail(check, "renderToStream rejected before returning a stream", error)
  }
  if (stream === undefined || !(stream instanceof ReadableStream)) {
    fail(check, "renderToStream must return a Web ReadableStream")
  }

  const reader = (stream as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let html = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!(value instanceof Uint8Array)) {
        await reader.cancel()
        fail(check, "every stream chunk must be a Uint8Array")
      }
      html += decoder.decode(value, { stream: true })
    }
    html += decoder.decode()
    return html
  } catch (error) {
    if (error instanceof RenderAdapterConformanceError) throw error
    return fail(check, "the HTML stream errored while being read", error)
  } finally {
    reader.releaseLock()
  }
}

/**
 * Execute the observable {@link RenderAdapter} interface against a framework-specific fixture.
 *
 * The promise resolves only when the adapter proves all shared invariants: page props reach a
 * page-only render, streams contain byte chunks, layout chains nest outermost-first, optional
 * buffered rendering is byte-for-byte hydration-equivalent to streaming for non-deferred content,
 * and hydration-head output is a stable string. It rejects with
 * {@link RenderAdapterConformanceError} naming the first failed check.
 *
 * Framework semantics outside the interface—Suspense scheduling, compiler plugins, DOM hydration,
 * error boundaries, and framework-specific primitives—remain the adapter package's local tests.
 */
export async function assertRenderAdapterConformance(
  adapter: RenderAdapter,
  fixture: RenderAdapterConformanceFixture,
): Promise<void> {
  const { markers, page, outerLayout, innerLayout, props } = fixture

  const pageHtml = await readHtml(() => adapter.renderToStream([page], props), "page stream")
  contains(pageHtml, markers.page, "page stream")
  contains(pageHtml, markers.data, "page props")
  contains(pageHtml, markers.pending, "page props")

  const chain = [outerLayout, innerLayout, page] as const
  const nestedHtml = await readHtml(() => adapter.renderToStream(chain, props), "layout stream")
  for (const marker of [
    markers.outer,
    markers.inner,
    markers.page,
    markers.data,
    markers.pending,
  ]) {
    contains(nestedHtml, marker, "layout stream")
  }
  const outerAt = nestedHtml.indexOf(markers.outer)
  const innerAt = nestedHtml.indexOf(markers.inner)
  const pageAt = nestedHtml.indexOf(markers.page)
  if (!(outerAt < innerAt && innerAt < pageAt)) {
    fail("layout order", "expected outer layout → inner layout → page source order")
  }

  if (adapter.renderToString !== undefined) {
    let buffered: unknown
    try {
      buffered = await adapter.renderToString(chain, props)
    } catch (error) {
      fail("buffered render", "renderToString rejected", error)
    }
    if (typeof buffered !== "string") fail("buffered render", "renderToString must return a string")
    const bufferedHtml = buffered as string
    if (fixture.deferred) {
      // Deferred content differs between streaming and buffered renders — only require every marker.
      for (const marker of [
        markers.outer,
        markers.inner,
        markers.page,
        markers.data,
        markers.pending,
      ]) {
        contains(bufferedHtml, marker, "buffered render")
      }
    } else if (bufferedHtml !== nestedHtml) {
      fail(
        "hydration equivalence",
        "renderToString and renderToStream produced different non-deferred markup",
      )
    }
  }

  let firstHead: unknown
  let secondHead: unknown
  try {
    firstHead = adapter.hydrationHead()
    secondHead = adapter.hydrationHead()
  } catch (error) {
    fail("hydration head", "hydrationHead threw", error)
  }
  if (typeof firstHead !== "string" || typeof secondHead !== "string") {
    fail("hydration head", "hydrationHead must return a string")
  }
  if (firstHead !== secondHead) fail("hydration head", "hydrationHead must be stable across calls")
}
