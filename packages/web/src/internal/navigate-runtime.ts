import {
  getBrowserNavigate,
  type NavigateFunction,
  type NavigateOptions,
  type NavigateTargetInput,
  resolveNavigate,
} from "../navigation.ts"

/**
 * The navigate every binding's `useNavigate` returns. It resolves the browser navigate at call time, so
 * it works as soon as `installHistory` has run and does nothing before then or on the server.
 */
// biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: NavigateFunction's object overload narrows `search` per route; at runtime both forms reach resolveNavigate's loose signature
export const navigateNow = ((
  to: string | number | NavigateTargetInput,
  options?: NavigateOptions,
) => {
  const navigate = getBrowserNavigate()
  if (navigate === undefined) return
  const resolved = resolveNavigate(to, options)
  navigate(resolved.to, resolved.options)
}) as NavigateFunction
