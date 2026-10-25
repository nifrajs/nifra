import type { MountRouterOptions, RenderProps, RouterState } from "@nifrajs/web"
import { routeProps as snapshotProps } from "@nifrajs/web/internal/route-props-runtime"

/** The client half of the server's `RenderProps`, so the first render matches the SSR markup. */
export function routeProps(
  state: RouterState,
  searchSchemas: MountRouterOptions["searchSchemas"],
  matchChains?: MountRouterOptions["matchChains"],
): RenderProps {
  const props = snapshotProps(state, searchSchemas, matchChains)
  // Where a navigation is heading, for `useNavigation().location` and `NavLink`'s `isPending`.
  return state.pendingPath === undefined ? props : { ...props, pendingPath: state.pendingPath }
}
