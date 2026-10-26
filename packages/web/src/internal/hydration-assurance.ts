/**
 * The hooks a hydration verification runner installs on a page under
 * `Symbol.for("nifra.hydration.assurance")`: each adapter's mount reports its framework's recoverable
 * hydration errors or warnings to them.
 */

const HYDRATION_ASSURANCE = Symbol.for("nifra.hydration.assurance")

/** The runner's hook named `name`, or `undefined` when no runner installed one. */
export function assuranceHook(
  name: "onRecoverableError",
): ((error: unknown, info?: unknown) => void) | undefined
export function assuranceHook(name: "onWarning"): ((message: string) => void) | undefined
export function assuranceHook(name: string): ((...args: unknown[]) => void) | undefined {
  const hooks: unknown = Reflect.get(globalThis, HYDRATION_ASSURANCE)
  if (typeof hooks !== "object" || hooks === null) return undefined
  const hook: unknown = Reflect.get(hooks, name)
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: the runner's hook is a function by the check before, called with what its framework reports
  return typeof hook === "function" ? (hook as (...args: unknown[]) => void) : undefined
}
