import { encodeComponentBytes, readComponentBytes } from "@nifrajs/web/server-components/stream"

/** Keep the rendered tree and its bounded hydration snapshot in sync across early exits. */
export async function updateProgressiveFlight<T>(
  flight: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  current: () => boolean,
  render: (stream: ReadableStream<Uint8Array>) => Promise<T>,
  publish: (tree: T, current: () => boolean) => void,
): Promise<{ readonly flight: string }> {
  const [renderStream, snapshotStream] = flight.tee()
  const snapshotController = new AbortController()
  const abortSnapshot = (): void => snapshotController.abort(signal.reason)
  signal.addEventListener("abort", abortSnapshot, { once: true })
  if (signal.aborted) abortSnapshot()
  const snapshot = readComponentBytes(snapshotStream, snapshotController.signal)
  const abandonSnapshot = (): void => {
    snapshotController.abort()
    void snapshot.catch(() => {
      // The render or cancellation error is authoritative; observe cleanup of the abandoned branch.
    })
  }

  try {
    const tree = await render(renderStream)
    if (!current() || signal.aborted) throw new Error("component_cancelled")
    publish(tree, current)
    return { flight: encodeComponentBytes(await snapshot) }
  } catch (error) {
    abandonSnapshot()
    throw error
  } finally {
    signal.removeEventListener("abort", abortSnapshot)
  }
}
