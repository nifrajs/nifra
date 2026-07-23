/**
 * Test-suite preload: stop loopback fetches from reusing a pooled connection.
 *
 * The suite starts ~30 servers on ephemeral ports (`listen(0)`) inside ONE Bun process, stopping each
 * before the next starts. The OS recycles ephemeral ports, and measurably does: wrapping `Bun.serve`
 * across a run shows a port handed out twice on essentially every run. `fetch` keeps a connection pool
 * keyed by origin - `127.0.0.1:PORT` - so once a port is recycled, a pooled entry pointing at the
 * server that just stopped can be picked up for a request meant for the new one.
 *
 * The result was a flake that moved between packages and never reproduced in isolation: a WebSocket
 * whose `open` never fired, a `clientIp` read from the wrong peer, and - the giveaway - a response
 * whose `content-type` was `null`, which is a dead connection rather than a wrong route. Roughly one
 * full-suite run in three failed somewhere; on a shared CI runner that is a PR failing at random.
 *
 * Forcing `Connection: close` removes the pool, and with it the precondition. Measured on the same
 * four packages: 2/8 runs flaked without this, 0/8 with it.
 *
 * This is a test-harness workaround, not a framework fix, and it is correct that it stays here: the
 * precondition is many short-lived servers churning ports inside a single process. A deployed server
 * holds one port for its lifetime, so no nifra user meets this condition.
 *
 * The tradeoff is real and worth stating: connection REUSE is no longer exercised by the suite. Only
 * loopback is touched, so any test that fetches a non-loopback origin keeps its default behaviour.
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
