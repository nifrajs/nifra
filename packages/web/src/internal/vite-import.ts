/**
 * The one place nifra imports Vite from.
 *
 * ## Why this is a module and not two `await import("vite")` calls
 *
 * Vite must not be imported before {@link relaxCaptureStackTrace} has run, and that requirement is
 * invisible at the call site. It was invisible in exactly the way that matters: the production build
 * relaxed first, the dev server did not, and the dev server's import ran earlier in the test process.
 * ESM caches a module that throws while EVALUATING, so once vite failed there it kept failing - every
 * later `loadVite` re-threw the cached error, with its shim correctly installed and no longer able to
 * help. One unguarded import poisons vite for the whole process.
 *
 * So the import lives here and the guard is not optional. A caller cannot get the module without it.
 */

/** Marks the shim as installed, so repeated imports do not wrap a wrapper. */
const RELAXED: unique symbol = Symbol.for("@nifrajs/web/relaxed-capture-stack-trace")

/**
 * Restore V8's `Error.captureStackTrace` contract on a runtime that is stricter than it.
 *
 * `captureStackTrace` is a V8 API and V8 decorates ANY object handed to it. Some runtimes require a
 * real Error - one with the internal slot - and throw "First argument must be an Error object".
 *
 * That breaks importing vite outright. Vite bundles `follow-redirects`, which builds its error types
 * the pre-class way:
 *
 *   function CustomError(props) { Error.captureStackTrace(this, this.constructor); … }
 *   CustomError.prototype = new (baseClass || Error)()
 *
 * The last line CONSTRUCTS `baseClass` while defining the subclass, so `this` inherits from Error but
 * was never built by it - and the throw lands during module evaluation, before vite exports anything.
 *
 * Decorating a stack is best-effort by definition, so swallowing the refusal loses nothing: the shim
 * delegates and suppresses only that. Installed once and deliberately not restored, since the strict
 * behaviour is the deviation and a library evaluated later meets the same wall.
 *
 * ## Why it does not probe first
 *
 * It used to construct an object like follow-redirects' and install the shim only if the runtime
 * refused it. That shipped and CI still failed, because the probe was not the same shape as the real
 * call: it passed `Object.create(Error.prototype)` and no `constructorOpt`, while follow-redirects
 * passes an object whose prototype is an Error INSTANCE plus `this.constructor`. One Bun build accepts
 * the former and rejects the latter, so the probe reported "permissive" and installed nothing.
 *
 * A probe has to predict every caller's construction pattern to be right, and is silently wrong when
 * it guesses short. Installing unconditionally cannot fail that way.
 */
export function relaxCaptureStackTrace(): void {
  const strict = Error.captureStackTrace
  if (typeof strict !== "function") return
  if ((Error as unknown as Record<PropertyKey, unknown>)[RELAXED] === true) return
  try {
    Error.captureStackTrace = ((target: object, constructorOpt?: unknown) => {
      try {
        ;(strict as (t: object, c?: unknown) => void).call(Error, target, constructorOpt)
      } catch {
        // The runtime refused to decorate this object. A missing `.stack` is not worth failing over.
      }
    }) as typeof Error.captureStackTrace
    Object.defineProperty(Error, RELAXED, { value: true, configurable: true })
  } catch {
    // The property is frozen or non-writable. Nothing can be done about the import that follows, but
    // failing HERE would replace vite's own error with an assignment error - strictly less
    // informative than letting the import fail and be reported by the caller.
  }
}

/**
 * Import the project's Vite, with the stack-trace contract restored first.
 *
 * Callers keep their own error message - the dev server and the production build fail for the same
 * reasons but need to say different things - so this deliberately lets the cause through untouched.
 * Use {@link isViteUnresolved} to tell "vite is not installed" from "vite failed to load".
 */
export async function importVite<T>(): Promise<T> {
  relaxCaptureStackTrace()
  return (await import("vite")) as unknown as T
}

/**
 * Whether a failed {@link importVite} means vite is absent rather than broken.
 *
 * `vite` is an OPTIONAL peer, so a project without it fails to RESOLVE - the common case, and the one
 * worth naming. But vite can also resolve and fail while EVALUATING, which is not a missing dependency
 * at all: vite 8 loads rolldown's native binding on import, and a binding that will not load surfaces
 * the same way. Telling that user to install what they already installed sends them the wrong way.
 */
export function isViteUnresolved(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause)
  return /cannot find (?:package|module)|ERR_MODULE_NOT_FOUND/i.test(message)
}
