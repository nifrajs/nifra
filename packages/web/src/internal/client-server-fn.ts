import type { ClientServerFn, ServerFnReference } from "../fn.ts"

/**
 * `fn` as a binding calls it. A binding calls a server function only in the browser, where the build
 * has swapped each `serverFn` declaration for its one-argument stub.
 */
export function clientServerFn<Input, Output>(
  fn: ServerFnReference<Input, Output>,
): ClientServerFn<Input, Output> {
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: in the browser every reference is the build's one-argument stub, never the declaration
  return fn as ClientServerFn<Input, Output>
}
