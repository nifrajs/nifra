/** Whether `error` is a load giving up because its request was aborted - the client went away - rather
 * than a failure: nobody reads the outcome, so there is nothing to report. */
export function isRequestAbort(signal: AbortSignal | undefined, error: unknown): boolean {
  return (
    signal?.aborted === true &&
    (error === signal.reason || (error instanceof Error && error.name === "AbortError"))
  )
}
