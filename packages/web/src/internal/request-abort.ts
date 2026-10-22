/** Whether `error` is a load giving up because its request was aborted - the client went away - rather
 * than a failure: nobody reads the outcome, so there is nothing to report. */
export function isRequestAbort(signal: AbortSignal | undefined, error: unknown): boolean {
  return (
    signal?.aborted === true &&
    (error === signal.reason || (error instanceof Error && error.name === "AbortError"))
  )
}

/** Report a deferred value's rejection to `log`, the app's error log, or to the console without
 * one. A rejection the client's leaving caused is not reported. */
export function reportDeferredRejection(
  signal: AbortSignal | undefined,
  error: unknown,
  log: ((error: unknown) => void) | undefined,
): void {
  if (isRequestAbort(signal, error)) return
  if (log === undefined) console.error("[nifra/web] deferred value rejected:", error)
  else log(error)
}
