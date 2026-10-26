/**
 * `withIdleTimeout()`: one request's own idle timeout on a Bun `listen()` server, held while slow
 * work runs and put back before the response goes out.
 */
import type { Context } from "./context.ts"
import { CONTEXT_IDLE_TIMEOUT, getNeverAbortSignal } from "./runtime-core.ts"

type MaybePromise<T> = T | Promise<T>

type IdleTimeoutControl = (this: unknown, seconds: number | undefined) => boolean

/** The `seconds` of every scope still running on a context. Deleted when the last one ends or the
 * request is aborted, which also tells a scope ending after an abort to leave the socket alone. */
const scopesOf = new WeakMap<object, number[]>()

const longest = (scopes: readonly number[]): number =>
  scopes.includes(0) ? 0 : Math.max(...scopes)

/**
 * Run `work` with the idle timeout of the request's connection set to `seconds` (`0` turns it off),
 * then put back the listener's.
 *
 * Bun closes a connection that moves no bytes for `listen()`'s `idleTimeoutSec` seconds (10 by
 * default), and a handler that is still working sends none, so an export or a long upstream call is
 * cut mid-flight. Raising `idleTimeoutSec` raises it for every connection, idle keep-alive ones
 * included; this raises it for one request. The listener's value is back before the response goes
 * out because Bun keeps the last value on the socket for the requests that follow on it, so a value
 * left in place would hold an idle connection open.
 *
 * The request's deadline (`requestTimeoutMs`, an inbound deadline) still bounds the response: when it
 * fires, the 503 is sent with the listener's timeout back and `c.signal` aborts, but `work`
 * keeps running unless it stops on that signal. Scopes nest: while several run on one request the
 * longest applies, and `0` outlasts any number. `seconds` runs from 0 to 255, the longest Bun holds
 * an idle connection; work that may idle longer takes `0`.
 *
 * A streamed response is sent after the handler returns, so call this inside the stream's producer
 * to hold it until the last chunk. Off `listen()` - another adapter, `app.fetch` in a test - it runs
 * `work` unchanged.
 *
 * @example
 * ```ts
 * import { withIdleTimeout } from "@nifrajs/core/idle-timeout"
 *
 * app.post("/exports", (c) => withIdleTimeout(c, 0, () => buildExport(c.body)))
 * // Every route declared after this one:
 * app.around((c, next) => withIdleTimeout(c, 120, next))
 * ```
 */
export function withIdleTimeout<T>(
  c: Context,
  seconds: number,
  work: () => MaybePromise<T>,
): MaybePromise<T> {
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 255) {
    throw new RangeError("withIdleTimeout: seconds must be an integer from 0 to 255")
  }
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: only RequestContext defines this key, with this signature; any other context leaves it undefined.
  const control = (c as Context & { [CONTEXT_IDLE_TIMEOUT]?: IdleTimeoutControl })[
    CONTEXT_IDLE_TIMEOUT
  ]
  const signal = c.signal
  if (control === undefined || signal.aborted) return work()
  const set = (value: number | undefined): void => {
    control.call(c, value)
  }
  let scopes = scopesOf.get(c)
  if (scopes === undefined) {
    scopes = []
    scopesOf.set(c, scopes)
  }
  const own = scopes
  own.push(seconds)
  set(longest(own))
  // An abort is the deadline's 503 or a closed client: either way the response is final, so the
  // listener's timeout goes back now rather than when the abandoned work settles.
  const abort = (): void => {
    if (scopesOf.get(c) !== own) return
    scopesOf.delete(c)
    set(undefined)
  }
  // The never-abort signal is one object shared by every request without a deadline.
  const listens = signal !== getNeverAbortSignal()
  if (listens) signal.addEventListener("abort", abort, { once: true })
  const end = (): void => {
    if (listens) signal.removeEventListener("abort", abort)
    if (scopesOf.get(c) !== own) return
    own.splice(own.indexOf(seconds), 1)
    if (own.length > 0) {
      set(longest(own))
      return
    }
    scopesOf.delete(c)
    set(undefined)
  }
  let result: MaybePromise<T>
  try {
    result = work()
  } catch (err) {
    end()
    throw err
  }
  if (!(result instanceof Promise)) {
    end()
    return result
  }
  return result.finally(end)
}
