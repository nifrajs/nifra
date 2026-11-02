import { getBrowserNavigate, type NavigateFunction } from "../navigation.ts"

/**
 * The navigate every binding's `useNavigate` returns. It resolves the browser navigate at call time, so
 * it works as soon as `installHistory` has run and does nothing before then or on the server.
 */
export const navigateNow: NavigateFunction = (to, options) => {
  getBrowserNavigate()?.(to, options)
}
