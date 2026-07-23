/**
 * Test-suite preload: force `Connection: close` on loopback fetches.
 *
 * ## What is actually known
 *
 * The suite has an intermittent failure that moves between packages and never reproduces in
 * isolation: a WebSocket whose `open` never fired, a `clientIp` read from the wrong peer, a large
 * static file served short, and - the most informative one - a response whose `content-type` was
 * `null`, which is a dead connection rather than a wrong route. Every affected test drives a real
 * socket. It has been seen in `packages/core`, `packages/client` and `packages/node`.
 *
 * ## What was disproved
 *
 * The original theory was port recycling: ~30 servers take ephemeral ports in one process, the OS
 * reuses one on essentially every run, and a connection to the stopped server gets picked up by the
 * new one. Wrapping `Bun.serve` confirms the reuse but **not the consequence** - 10 consecutive runs
 * with no mitigation showed exactly one port reuse each and zero failures. Reuse happens constantly
 * and is not sufficient to cause the failure.
 *
 * A follow-up that made ephemeral ports unique per process measured WORSE than this (6/12 vs ~1/8),
 * then 0/8 on the same code minutes later. Which is the real lesson: at 8-12 runs the measurements
 * cannot distinguish configurations, and earlier "0/10, fixed" readings here were within that noise.
 *
 * ## Why this stays
 *
 * It is cheap, it is scoped to loopback, and the rate with it has never been observed higher than
 * without. It is a MITIGATION with an unproven mechanism, not a fix - do not read the flake as solved.
 * The tradeoff: connection reuse is no longer exercised by the suite.
 *
 * The next step is a reliable reproduction, not a third guess. Chasing it needs the failing assertion
 * to report what it saw - most of these tests discard the error (`new Error("open failed")`), which is
 * why several rounds of investigation produced a rate and never a cause.
 */

const realFetch = globalThis.fetch

function isLoopback(target: RequestInfo | URL): boolean {
  const url = target instanceof Request ? target.url : String(target)
  return url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:")
}

// @ts-expect-error - deliberate harness override; the wrapper keeps `fetch`'s call signature.
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  if (!isLoopback(input)) return realFetch(input, init)
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  )
  headers.set("connection", "close")
  return realFetch(input, { ...init, headers })
}
