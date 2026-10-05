import { Fragment, jsx as nativeJsx, jsxs as nativeJsxs } from "react/jsx-runtime"
import { guardedClientElement } from "./guard.ts"

export { Fragment }

export function jsx(type: unknown, props: unknown, key?: unknown): unknown {
  return (
    guardedClientElement(type, props, key) ??
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The guard handles registered client references; other elements use the unchanged native React JSX ABI.
    nativeJsx(type as Parameters<typeof nativeJsx>[0], props, key as string | undefined)
  )
}
export function jsxs(type: unknown, props: unknown, key?: unknown): unknown {
  return (
    guardedClientElement(type, props, key) ??
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The guard handles registered client references; other elements use the unchanged native React JSX ABI.
    nativeJsxs(type as Parameters<typeof nativeJsxs>[0], props, key as string | undefined)
  )
}
