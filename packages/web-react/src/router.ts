/**
 * `@nifrajs/web-react/router` — React routing bindings over the agnostic `@nifrajs/web` router:
 * `<Link>`/`<NavLink>`, `useNavigate`, `useParams`, `useLocation`, `useSearchParams`, and `<Navigate>`.
 *
 * These read the current route from a {@link RouterContext} that `compose` provides on BOTH the SSR
 * render and the client mount (seeded from the request match / router state respectively), so the read
 * hooks (`useParams`/`useLocation`/`useSearchParams`) are SSR-correct and hydrate with no mismatch.
 * Navigation goes through `@nifrajs/web`'s DOM-free navigate bridge (`getBrowserNavigate`, populated by
 * `installHistory`) — so this module imports only `react` (never `react-dom/*`), and a route component
 * can use these on the server and the client without dragging a DOM build into the wrong bundle. No JSX
 * (the package builds with plain `tsc`), so everything is `createElement`.
 */
import { getBrowserNavigate, type NavigateOptions } from "@nifrajs/web"
import {
  type AnchorHTMLAttributes,
  type CSSProperties,
  createContext,
  createElement,
  forwardRef,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
} from "react"

/** The current route the routing hooks read. Provided by `compose` on SSR + client mount alike. */
export interface RouterContextValue {
  /** The matched route's decoded path params (`/users/:id` → `{ id: "7" }`). */
  readonly params: Readonly<Record<string, string>>
  /** The current URL's `pathname + search` (no hash — the router never carries one). */
  readonly path: string
  /** True while a client navigation (or revalidation) is in flight — the current route stays mounted
   * until the new one is ready. Always `false` on SSR (loaders block before render). Drives loading UI
   * via {@link useNavigation}. */
  readonly pending: boolean
}

// Frozen empty params so the default context value has a stable reference (no needless re-renders).
const EMPTY_PARAMS: Readonly<Record<string, string>> = Object.freeze({})

/** Router context. The default ({} params, "" path) is what a component sees when rendered outside a
 * nifra route tree — the hooks stay defined (no throw) so a stray `useParams` degrades gracefully. */
export const RouterContext = createContext<RouterContextValue>({
  params: EMPTY_PARAMS,
  path: "",
  pending: false,
})

/** Split a `pathname + search` into its parts. `search` keeps its leading `?` (like `location.search`);
 * an empty query yields `""`. */
function splitPath(path: string): { readonly pathname: string; readonly search: string } {
  const q = path.indexOf("?")
  return q === -1
    ? { pathname: path, search: "" }
    : { pathname: path.slice(0, q), search: path.slice(q) }
}

/**
 * The matched route's decoded path params — `/users/:id` on `/users/7` → `{ id: "7" }`. SSR-correct:
 * `compose` provides the same value server-side (from the request match) and client-side (from router
 * state), so a param rendered into markup doesn't flash on hydration.
 */
export function useParams<
  T extends Record<string, string | undefined> = Record<string, string>,
>(): Readonly<T> {
  return useContext(RouterContext).params as Readonly<T>
}

/** The parsed current location. `hash` is always `""` — the fragment is client-only and never reaches
 * the router state / server, so exposing a live hash would hydration-mismatch; read `window.location.hash`
 * directly (in an effect) if you truly need it. */
export interface Location {
  readonly pathname: string
  readonly search: string
  readonly hash: string
}

/** The current {@link Location} (`pathname`/`search`/`hash`), derived from the router context. */
export function useLocation(): Location {
  const { path } = useContext(RouterContext)
  return useMemo(() => {
    const { pathname, search } = splitPath(path)
    return { pathname, search, hash: "" }
  }, [path])
}

/** The current navigation state, mirroring the Remix `useNavigation()` shape for familiarity. */
export interface Navigation {
  /** True while a client navigation (or revalidation) is in flight. The current route stays mounted
   * until the new one is ready, so this drives a loading indicator, not a route swap. */
  readonly pending: boolean
  /** `"loading"` while a navigation is in flight, else `"idle"`. */
  readonly state: "idle" | "loading"
}

/**
 * Observe client navigation to drive loading UI (a top-bar spinner, dimmed content, a skeleton). nifra
 * navigates imperatively - it fetches the next route's chunk + loader data while the current route stays
 * on screen, then swaps - so `pending` is the signal for "a transition is in flight," not a Suspense
 * boundary. Always `{ pending: false, state: "idle" }` on the server (loaders block before render), so
 * it is hydration-safe.
 *
 * ```tsx
 * const { pending } = useNavigation()
 * return <div className={pending ? "opacity-60" : ""}>{pending && <TopBarSpinner />}<Outlet /></div>
 * ```
 */
export function useNavigation(): Navigation {
  const { pending } = useContext(RouterContext)
  return useMemo(() => ({ pending, state: pending ? "loading" : ("idle" as const) }), [pending])
}

/** Convenience boolean form of {@link useNavigation}: `true` while a client navigation is in flight. */
export function usePending(): boolean {
  return useContext(RouterContext).pending
}

/** A programmatic navigate: a string path (push, or replace via `{ replace: true }`) or a history delta
 * (`-1`/`1`). A no-op on the server / before hydration (a render-time navigate isn't valid — use
 * {@link Navigate}, which navigates in an effect). */
export type NavigateFunction = (to: string | number, options?: NavigateOptions) => void

/** Get the {@link NavigateFunction}. Stable across renders; resolves the browser navigate at call time
 * (so it works as soon as `installHistory` has run, and no-ops before then / on the server). */
export function useNavigate(): NavigateFunction {
  return useCallback((to, options) => {
    const navigate = getBrowserNavigate()
    if (navigate !== undefined) navigate(to, options)
  }, [])
}

/** The value forms `setSearchParams` accepts. */
export type SearchParamsInit = URLSearchParams | Record<string, string | readonly string[]> | string

function toSearchParams(init: SearchParamsInit): URLSearchParams {
  if (init instanceof URLSearchParams) return init
  if (typeof init === "string") return new URLSearchParams(init)
  const usp = new URLSearchParams()
  for (const [key, value] of Object.entries(init)) {
    if (Array.isArray(value)) for (const item of value) usp.append(key, item)
    else usp.set(key, value as string)
  }
  return usp
}

/** Set the query string. Accepts a `URLSearchParams`, a record, a raw string, or an updater of the
 * current params; navigates to the same pathname with the new query (push, or replace via options). */
export type SetSearchParams = (
  next: SearchParamsInit | ((prev: URLSearchParams) => SearchParamsInit),
  options?: NavigateOptions,
) => void

/**
 * The current query as a `URLSearchParams` (SSR-correct via the router context) plus a setter that
 * navigates to the new query. Mirrors react-router's `useSearchParams` tuple.
 */
export function useSearchParams(): readonly [URLSearchParams, SetSearchParams] {
  const { path } = useContext(RouterContext)
  const { pathname, search } = splitPath(path)
  const searchParams = useMemo(() => new URLSearchParams(search), [search])
  const navigate = useNavigate()
  const setSearchParams = useCallback<SetSearchParams>(
    (next, options) => {
      const resolved = typeof next === "function" ? next(new URLSearchParams(search)) : next
      const qs = toSearchParams(resolved).toString()
      navigate(pathname + (qs !== "" ? `?${qs}` : ""), options)
    },
    [navigate, pathname, search],
  )
  return [searchParams, setSearchParams] as const
}

/** A left-click with no modifier and no new-tab target — the only click a client router should
 * intercept (Cmd/Ctrl/Shift/Alt or a `_blank` target means the user wants native behavior). */
function isPlainLeftClick(event: MouseEvent, target: string | undefined): boolean {
  if (event.button !== 0) return false
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false
  return target === undefined || target === "" || target === "_self"
}

/** {@link Link} props: every `<a>` attribute except `href` (set from `to`), plus `to` + `replace`. */
export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  /** Same-origin destination path (e.g. `/users/7?tab=posts`). Rendered as the `<a href>`. */
  readonly to: string
  /** Replace the current history entry instead of pushing. */
  readonly replace?: boolean
}

/**
 * A client-navigating anchor. Renders a real `<a href={to}>` (so it's a working link before hydration
 * and for right-click / open-in-new-tab), and on a plain left-click navigates through the router
 * instead of a full reload. Calling `navigate` + `preventDefault` here means `installHistory`'s
 * document-level click handler sees `defaultPrevented` and stands down — exactly one navigation.
 */
export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { to, replace, onClick, target, ...rest },
  ref,
) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event)
    if (event.defaultPrevented) return // the app's own handler already took over
    if (!isPlainLeftClick(event, target)) return // modified / new-tab click → native
    const navigate = getBrowserNavigate()
    if (navigate === undefined) return // pre-hydration → let the native <a href> full-load
    event.preventDefault()
    navigate(to, { replace: replace === true })
  }
  return createElement("a", { ...rest, href: to, target, onClick: handleClick, ref })
})

/** The state a {@link NavLink}'s function-form `className`/`style`/`children` receive. */
export interface NavLinkRenderProps {
  /** True when the current location matches this link's `to` (prefix match, or exact when `end`). */
  readonly isActive: boolean
  /** Reserved for a future pending-navigation signal; currently always `false`. */
  readonly isPending: boolean
}

/** {@link NavLink} props — like {@link LinkProps}, but `className`/`style`/`children` may be functions
 * of the active state, and `end`/`caseSensitive` tune matching. */
export interface NavLinkProps extends Omit<LinkProps, "className" | "style" | "children"> {
  /** Match the full path exactly instead of as a prefix (use for `to="/"` so it isn't always active). */
  readonly end?: boolean
  /** Match case-sensitively (default: case-insensitive, like the DOM). */
  readonly caseSensitive?: boolean
  readonly className?: string | ((props: NavLinkRenderProps) => string | undefined)
  readonly style?: CSSProperties | ((props: NavLinkRenderProps) => CSSProperties | undefined)
  readonly children?: ReactNode | ((props: NavLinkRenderProps) => ReactNode)
}

/** Normalize a pathname for comparison: optional case-fold + drop a single trailing slash (but keep a
 * bare `"/"`). */
function normalizePath(pathname: string, caseSensitive: boolean): string {
  const cased = caseSensitive ? pathname : pathname.toLowerCase()
  return cased !== "/" && cased.endsWith("/") ? cased.slice(0, -1) : cased
}

/**
 * A {@link Link} that knows whether it points at the current location. Adds `aria-current="page"` when
 * active and resolves function-form `className`/`style`/`children` with `{ isActive, isPending }`.
 * Default matching is prefix-on-segment-boundary (so `/users` is active on `/users/7`); pass `end` for
 * an exact match.
 */
export const NavLink = forwardRef<HTMLAnchorElement, NavLinkProps>(function NavLink(
  { to, end, caseSensitive, className, style, children, ...rest },
  ref,
) {
  const { pathname } = useLocation()
  const cs = caseSensitive === true
  const current = normalizePath(pathname, cs)
  const target = normalizePath(splitPath(to).pathname, cs)
  const isActive = end === true ? current === target : matchesPrefix(current, target)
  const renderProps: NavLinkRenderProps = { isActive, isPending: false }
  const resolvedClassName = typeof className === "function" ? className(renderProps) : className
  const resolvedStyle = typeof style === "function" ? style(renderProps) : style
  const resolvedChildren = typeof children === "function" ? children(renderProps) : children
  return createElement(
    Link,
    {
      ...rest,
      to,
      ref,
      ...(resolvedClassName !== undefined ? { className: resolvedClassName } : {}),
      ...(resolvedStyle !== undefined ? { style: resolvedStyle } : {}),
      // `aria-current="page"` is the accessible active marker; style with `[aria-current="page"]`.
      "aria-current": isActive ? "page" : undefined,
    },
    resolvedChildren,
  )
})

/** Prefix match on a segment boundary: `current` is `target`, or lives under it (`target + "/"`…). A
 * bare `"/"` target is a prefix of everything (so `<NavLink to="/">` is active everywhere unless `end`). */
function matchesPrefix(current: string, target: string): boolean {
  if (current === target) return true
  return current.startsWith(target === "/" ? "/" : `${target}/`)
}

/** {@link Navigate} props: the destination `to` and whether to `replace` the history entry. */
export interface NavigateProps {
  readonly to: string
  readonly replace?: boolean
}

/**
 * Declaratively navigate on mount — the component analogue of `useNavigate` (e.g. a guard that renders
 * `<Navigate to="/login" replace />`). Navigates in an effect, so it's a safe no-op during SSR (renders
 * `null`); the redirect happens once on the client after hydration.
 */
export function Navigate({ to, replace }: NavigateProps): null {
  const navigate = useNavigate()
  useEffect(() => {
    navigate(to, { replace: replace === true })
  }, [navigate, to, replace])
  return null
}
