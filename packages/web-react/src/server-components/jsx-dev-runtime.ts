import { Fragment, jsxDEV as nativeJsxDEV } from "react/jsx-dev-runtime"
import { guardedClientElement } from "./guard.ts"

export { Fragment }

export function jsxDEV(
  type: unknown,
  props: unknown,
  key: unknown,
  isStaticChildren: boolean,
  source?: { fileName: string; lineNumber: number; columnNumber: number },
  self?: unknown,
): unknown {
  return (
    guardedClientElement(type, props, key) ??
    nativeJsxDEV(
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The guard handles registered client references; other elements use the unchanged native React development JSX ABI.
      type as Parameters<typeof nativeJsxDEV>[0],
      props,
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The guard handles registered client references; other elements use the unchanged native React development JSX ABI.
      key as string | undefined,
      isStaticChildren,
      source,
      self,
    )
  )
}
